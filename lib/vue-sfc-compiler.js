const bedrock = require('bedrock');
const async = require('async');
const fs = require('fs-extra');
const path = require('path');
const webpack = require('webpack');
const memoryfs = require('memory-fs');
const BedrockError = bedrock.util.BedrockError;

const logger = bedrock.loggers.get('app').child('bedrock-views');

const cache = {};

module.exports = enqueue;

function enqueue(filename, componentPath, callback) {
  /* Compiler cache + queue:

    This is a very simple compiler cache + queue system that should work for
    development mode compilation of Vue SFCs. Not for production -- which
    is fine because all Vue SFCs are precompiled for production.

    Algorithm:

    1. Stat the Vue SFC and get its last write time.
    2. Build a filename for an expected cached file based on write time.
    3. Open the cached file and read it and return the result.
    4. On error, add a task to the queue to compile and create the file.
  */
  const cacheDir = bedrock.config.views.system.paths.vue.cache;

  let entry = cache[filename];
  if(!entry) {
    entry = cache[filename] = {
      mtime: 0,
      dependencies: [filename],
      // one queue for every Vue SFC with just 1 task permitted at a time
      queue: async.queue(taskHandler, 1)
    };
  }

  async.auto({
    mtime: callback => mostRecentMtime(filename, entry.dependencies, callback),
    cache: ['mtime', (results, callback) => {
      const {mtime} = results;
      const cachedFilename = path.join(cacheDir, componentPath, `${mtime}.js`);
      const task = {
        filename,
        cachedFilename,
        mtime,
        componentPath
      };
      entry.queue.push(task, err => callback(err, task.bundle));
    }]
  }, (err, results) => err ? callback(err) : callback(null, results.cache));
}

function taskHandler(task, callback) {
  /* Queue algorithm:

    1. A queue task will first check the in-memory cache for the latest
       cache entry. If its `mtime` is greater than or equal what is to be
       compiled, then the new cached file is opened and returned.
    2. The compiler is run and a new bundle is produced.
    3. Any existing cached files are removed and the new bundle is written
       to disk.
    4. The bundle is returned.
  */
  const entry = cache[task.filename];
  if(entry.mtime >= task.mtime) {
    logger.debug(`Loading cached Vue SFC: ${task.componentPath}`);

    // a newer version was already compiled, use it
    return fs.readFile(entry.cachedFilename, 'utf8', (err, bundle) => {
      if(err) {
        // clear cache for retry
        delete cache[task.filename];
        return callback(err);
      }
      task.bundle = bundle;
      callback();
    });
  }

  logger.debug(`Compiling Vue SFC: ${task.componentPath}`);

  async.auto({
    compile: callback => compile(task.filename, callback),
    emptyDir: callback => fs.emptyDir(
      path.dirname(task.cachedFilename), callback),
    write: ['compile', (results, callback) => {
      task.bundle = results.compile.bundle;
      fs.writeFile(task.cachedFilename, task.bundle, 'utf8', callback);
    }],
    finish: ['write', (results, callback) => {
      entry.mtime = task.mtime;
      entry.cachedFilename = task.cachedFilename;
      entry.dependencies = results.compile.dependencies;
      callback();
    }]
  }, callback);
}

function compile(fixture, callback) {
  const compiler = webpack({
    context: '/tmp',
    mode: 'development',
    target: 'web',
    entry: fixture,
    output: {
      path: path.resolve(__dirname),
      filename: 'bundle.js',
      libraryTarget: 'umd'
    },
    module: {
      rules: [{
        test: /\.vue$/,
        use: {
          loader: require.resolve('vue-loader'),
          options: {
            hotReload: false,
            cssSourceMap: false,
            loaders: {
              // disable babel, unnecessary overhead
              // TODO: to enable, must do:
              // npm install babel-loader and babel-core
              js: '',//require.resolve('babel-loader'),
              css: require.resolve('vue-style-loader') + '!' +
                require.resolve('css-loader')
            }
          }
        }
      }]
    }
  });

  compiler.outputFileSystem = new memoryfs();

  compiler.run((err, stats) => {
    if(err) {
      return callback(err);
    }
    if(stats.compilation.errors.length > 1) {
      logger.error(`SFC compilation error:\nFile: ${fixture}\n` +
        stats.compilation.errors);
      return callback(new BedrockError(
        'Could not compile Vue Single Component File.',
        'DataError', {
          'public': true,
          httpStatusCode: 500,
          errors: stats.compilation.errors.map(e => String(e))
        }));
    }

    const dependencies = [fixture, ...stats.compilation.fileDependencies]
      .filter(dep => typeof dep === 'string');
    const bundlePath = path.resolve(__dirname, 'bundle.js');
    const bundle = compiler.outputFileSystem.readFileSync(
      bundlePath, 'utf8');
    callback(null, {bundle, dependencies});
  });
}

function mostRecentMtime(filename, deps, callback) {
  let mtime = 0;
  async.each(deps, (dep, callback) => {
    fs.stat(dep, (err, stat) => {
      if(err) {
        if(filename === dep) {
          return callback(err);
        }
      } else {
        mtime = Math.max(mtime, stat.mtimeMs);
      }
      callback();
    });
  }, err => callback(err, mtime));
}