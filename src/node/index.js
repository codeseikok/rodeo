'use strict';

const _ = require('lodash'),
  bluebird = require('bluebird'),
  kernelsPythonClient = require('./kernels/python/client'),
  cuid = require('cuid'),
  electron = require('electron'),
  browserWindows = require('./services/browser-windows'),
  files = require('./services/files'),
  ipcPromises = require('./services/ipc-promises'),
  path = require('path'),
  menuDefinitions = require('./services/menu-definitions'),
  os = require('os'),
  steveIrwin = require('./kernels/python/steve-irwin'),
  updater = require('./services/updater'),
  installer = require('./services/installer'),
  PlotServer = require('./services/plot-server'),
  yargs = require('yargs'),
  argv = getArgv(),
  log = require('./services/log').asInternal(__filename),
  staticFileDir = path.resolve(__dirname, '../browser/'),
  kernelClients = {},
  windowUrls = {
    mainWindow: 'main.html',
    startupWindow: 'startup.html',
    designWindow: 'design.html',
    freeTabsOnlyWindow: 'free-tabs-only.html'
  },
  systemFactTimeout = 120,
  autoCompleteTimeout = 5,
  second = 1000;

let plotServerInstance,
  isStartupFinished = false;

function getArgv() {
  let sliceNum;

  if (_.endsWith(process.argv[0], 'Electron')) {
    sliceNum = 2;
  } else {
    sliceNum = 1;
  }

  return yargs
    .env('RODEO')
    .boolean('dev').default('pythons', false)
    .boolean('pythons').default('pythons', true)
    .boolean('startup').default('startup', true)
    .parse(process.argv.slice(sliceNum));
}

/**
 * @param {object} obj
 * @param {object} validOptions
 * @throws if the obj does not match the validOptions
 */
function assertValidObject(obj, validOptions) {
  const bannedProperties = _.omit(obj, Object.keys(validOptions)),
    validators = {
      string: _.isString,
      object: _.isPlainObject,
      number: _.isNumber,
      boolean: _.isBoolean
    };

  if (_.size(bannedProperties) > 0) {
    throw new Error('Properties ' + Object.keys(bannedProperties) + ' are not allowed');
  }

  _.each(validOptions, function (definition, key) {
    const value = obj[key];
    let expectedType, isRequired;

    if (_.isObject(definition)) {
      expectedType = definition.type;
      isRequired = definition.required;
    } else if (_.isString(definition)) {
      expectedType = definition;
      isRequired = false;
    } else {
      throw new Error('Bad definition of object type assertion: ' + definition + ' for ' + key);
    }

    if (!validators[expectedType]) {
      throw new Error('Missing validator type ' + expectedType + ' for property ' + key);
    }

    if (isRequired && value === undefined) {
      throw new Error('Missing required property ' + key);
    }

    if (value !== undefined && !validators[expectedType](value)) {
      throw new Error('Invalid property ' + key + ': expected ' + expectedType + ' but got ' + value);
    }
  });
}

/**
 * Find a package.json, hopefully ours.
 * @returns {object|false}
 */
function getPkg() {
  let dir = __dirname,
    pkg;

  while (dir.length > 1) {
    dir = path.resolve(dir, '..');
    pkg = files.getJSONFileSafeSync(path.join(dir, 'package.json'));
    if (pkg) {
      return pkg;
    }
  }

  return false;
}

/**
 * Quit the application
 */
function onQuitApplication() {
  const app = electron.app;

  log('info', 'onQuitApplication');

  app.quit();

  if (process.platform === 'linux') {
    log('info', 'forcing quit on linux');
    process.exit(0);
  }
}

/**
 * @param {string} dir
 * @returns {Promise}
 */
function onFiles(dir) {
  if (!_.isString(dir)) {
    throw new Error('onFiles expects a string as the first argument');
  }

  return files.readDirectory(path.resolve(files.resolveHomeDirectory(dir)));
}

/**
 * On markdown?  Should change the name of this to be more clear.
 * @param {Event} event
 * @param {object} data
 * @returns {Promise}
 */
function onKnitHTML(event, data) {
  // const doc = data.doc;
  //
  // return getKernelClient('python').then(function (pythonInstance) {
  //   return md.knitHTML(doc, pythonInstance);
  // }).then(function (html) {
  //   return md.applyReportTemplate(html);
  // }).then(function (html) {
  //   event.returnValue = html; // this isn't sync anymore, so this won't work, if it ever did
  //   return html;
  // });
  return bluebird.resolve({event, data});
}

function onPDF() {
  require('dialog').showSaveDialog({
    title: 'Save Report'
  }, function (destfile) {
    if (!/\.pdf/.test(destfile)) {
      destfile += '.pdf';
    }

    browserWindows.send('mainWindow', 'pdf', destfile);
  });
}

function onFileStats(filename) {
  return files.getStats(files.resolveHomeDirectory(filename));
}

function onResolveFilePath(filename) {
  if (!_.isString(filename)) {
    throw new TypeError('Expected first parameter to be a filename');
  }

  if (filename[0] === '~') {
    return path.join(os.homedir(), filename.slice(1));
  }

  return path.resolve(filename);
}

function onGetFile(filename) {
  return files.readFile(files.resolveHomeDirectory(filename));
}

function onSaveFile(filename, contents) {
  return files.writeFile(filename, contents);
}

/**
 *
 * @param {string} extension
 * @param {object} data
 * @param {string} property
 * @returns {Promise}
 */
function replacePropertyWithTemporaryFile(extension, data, property) {
  if (data[property]) {
    return files.saveToTemporaryFile(extension, data[property]).then(function (filepath) {
      let name = _.last(filepath.split(path.sep)),
        route = plotServerInstance.addRouteToFile(filepath, '/' + name);

      log('info', 'new plot served from', route);

      data[property] = route;
    });
  } else {
    log('debug', 'no', property, 'on data');
  }
}

/**
 * Transform display data events to refer to a temporary file instead of passing raw data
 * @param {object} event
 * @returns {Promise}
 */
function displayDataTransform(event) {
  const type = _.get(event, 'result.msg_type'),
    data = _.get(event, 'result.content.data');

  if (type === 'display_data' && data) {
    if (data['image/png']) {
      data['image/png'] = new Buffer(data['image/png'], 'base64');
    }

    return bluebird.all([
      replacePropertyWithTemporaryFile('.html', data, 'text/html'),
      replacePropertyWithTemporaryFile('.png', data, 'image/png'),
      replacePropertyWithTemporaryFile('.svg', data, 'image/svg')
    ]).then(function () {
      return event;
    });
  }

  return bluebird.resolve(event);
}

/**
 * Forward these events along to a BrowserWindow (but only if the window exists)
 * @param {string} windowName
 * @param {EventEmitter} emitter
 * @param {string} eventName
 */
function subscribeBrowserWindowToEvent(windowName, emitter, eventName) {
  emitter.on(eventName, function (event) {
    displayDataTransform(event).then(function (normalizedEvent) {
      browserWindows.send.apply(browserWindows, [windowName, eventName].concat([normalizedEvent]));
    }).catch(error => log('error', error));
  });
}

/**
 * @param {string} windowName
 * @param {JupyterClient} client
 */
function subscribeWindowToKernelEvents(windowName, client) {
  subscribeBrowserWindowToEvent(windowName, client, 'shell');
  subscribeBrowserWindowToEvent(windowName, client, 'iopub');
  subscribeBrowserWindowToEvent(windowName, client, 'stdin');
  subscribeBrowserWindowToEvent(windowName, client, 'event');
  subscribeBrowserWindowToEvent(windowName, client, 'input_request');
  subscribeBrowserWindowToEvent(windowName, client, 'error');
}

// Quit when all windows are closed.
function onWindowAllClosed() {
  log('info', 'onWindowAllClosed');
  const app = electron.app;

  app.quit();
}

/**
 * It's nice to start loading the main window in the background while other windows are keeping the user busy.
 * @returns {BrowserWindow}
 */
function preloadMainWindow() {
  const windowName = 'mainWindow';

  return browserWindows.createMainWindow(windowName, {
    url: 'file://' + path.join(staticFileDir, windowUrls[windowName])
  });
}

function getMainWindow() {
  const windowName = 'mainWindow';
  let window = browserWindows.getByName(windowName);

  if (!window) {
    window = browserWindows.createMainWindow(windowName, {
      url: 'file://' + path.join(staticFileDir, windowUrls[windowName])
    });
  }

  return window;
}

/**
 * @returns {Promise}
 */
function startMainWindow() {
  return new bluebird(function (resolve) {
    const window = getMainWindow();

    if (argv.dev === true) {
      window.openDevTools();
    }

    resolve(attachApplicationMenu(window.webContents).then(function () {
      window.show();
    }));
  });
}

function startMainWindowWithOpenFile(filename, stats) {
  return bluebird.try(function () {
    let window;
    const windowName = 'mainWindow';

    window = browserWindows.createMainWindow(windowName, {
      url: 'file://' + path.join(staticFileDir, windowUrls[windowName]),
      startActions: [
        {type: 'ADD_FILE', filename, stats}
      ]
    });

    if (argv.dev) {
      window.openDevTools();
    }

    return attachApplicationMenu(window.webContents)
      .then(function () {
        window.show();
      });
  });
}

function startMainWindowWithWorkingDirectory(filename) {
  try {
    process.chdir(filename);
  } catch (ex) {
    log('error', 'failed to change working directory to', filename);

    return startStartupWindow();
  }

  return files.readDirectory(filename).then(function (files) {
    const windowName = 'mainWindow';
    let window = browserWindows.createMainWindow(windowName, {
      url: 'file://' + path.join(staticFileDir, windowUrls[windowName]),
      startActions: [
        {type: 'SET_VIEWED_PATH', path: filename, files}
      ]
    });

    if (argv.dev) {
      window.openDevTools();
    }

    return attachApplicationMenu(window.webContents).then(function () {
      window.show();
    });
  });
}
/**
 * @returns {Promise}
 */
function startStartupWindow() {
  return new bluebird(function (resolve) {
    const windowName = 'startupWindow',
      window = browserWindows.createStartupWindow(windowName, {
        url: 'file://' + path.join(staticFileDir, windowUrls[windowName])
      });

    if (argv.dev === true) {
      window.openDevTools();
    }

    preloadMainWindow();

    window.webContents.on('did-finish-load', function () {
      window.show();
      window.once('close', function () {
        if (isStartupFinished) {
          startMainWindow().catch(function (error) {
            log('error', error);
          });
        }
      });
    });

    resolve();
  });
}

/**
 * When Electron is ready, we can start making windows
 */
function onReady() {
  let windowName, window;

  return bluebird.try(function () {
    if (argv.design) {
      windowName = 'designWindow';
      window = browserWindows.create(windowName, {
        url: 'file://' + path.join(staticFileDir, windowUrls[windowName])
      });
      window.show();
    } else if (_.size(argv._)) {
      const statSearch = _.map(argv._, arg => {
        return files.getStats(arg)
          .catch(_.noop)
          .then(stats => {
            return {name: path.resolve(arg), stats};
          });
      });

      return bluebird.all(statSearch).then(function (files) {
        log('info', 'files', files);

        const file = _.head(_.compact(files));

        if (file) {
          if (file.stats.isDirectory()) {
            return startMainWindowWithWorkingDirectory(file.name);
          } else {
            return startMainWindowWithOpenFile(file.name, file.stats);
          }
        } else {
          log('info', 'no files found with', argv._);
          return startStartupWindow();
        }
      });
    } else if (argv.startup === false) {
      return startMainWindow();
    } else {
      return startStartupWindow();
    }
  }).then(attachIpcMainEvents)
    .catch(error => log('error', error));
}

/**
 * This runs in a short-lived python instance that is killed immediately after success or failure.
 * @param {object} options
 * @param {string} options.cmd
 * @param {string} options.cwd
 * @returns {Promise}
 */
function onCheckKernel(options) {
  assertValidObject(options, {
    cmd: {type: 'string', isRequired: true},
    cwd: {type: 'string'}
  });

  return kernelsPythonClient.checkPython(options);
}

/**
 * @param {object} options
 * @param {string} options.cmd
 * @param {string} [options.cwd]
 * @returns {Promise}
 */
function onCreateKernelInstance(options) {
  assertValidObject(options, {
    cmd: {type: 'string', isRequired: true},
    cwd: {type: 'string'}
  });

  if (!options) {
    throw new Error('Must provide kernel options to run python');
  } else if (!options.cmd) {
    throw new Error('Must provide cmd to create python instance, i.e., {cmd: "python"}');
  }

  return new bluebird(function (resolveInstanceId) {
    let instanceId = cuid();

    kernelsPythonClient.create(options).then(function (client) {
      log('info', 'created new python kernel process', instanceId, options);
      subscribeWindowToKernelEvents('mainWindow', client);

      kernelClients[instanceId] = new bluebird(function (resolveClient) {
        client.on('ready', function () {
          log('info', 'new python kernel process is ready', instanceId, options);
          resolveClient(client);
        });
      });

      return kernelClients[instanceId];
    }).catch(function () {
      log('error', 'failed to create instance', instanceId);
      delete resolveInstanceId(instanceId);
    });

    resolveInstanceId(instanceId);
  });
}

/**
 * @param {string} id
 * @returns {Promise}
 */
function onKillKernelInstance(id) {
  if (!kernelClients[id]) {
    throw new Error('Kernel with that id does not exist.');
  }

  let promise = kernelClients[id];

  delete kernelClients[id];
  log('info', 'deleted python kernel process reference', id);

  return promise
    .then(client => client.kill()).then(function () {
      log('info', 'successfully killed python kernel process reference', id);
    });
}

/**
 * @param {string} id
 * @returns {Promise}
 */
function getKernelInstanceById(id) {
  log('info', 'getKernelInstanceById', id);

  if (!kernelClients[id]) {
    throw new Error('Kernel with this id does not exist: ' + id);
  }

  return kernelClients[id];
}

/**
 * @param {object} options
 * @param {string} options.instanceId
 * @param {string} text
 * @returns {Promise}
 */
function onExecute(options, text) {
  if (!text) {
    throw Error('Missing text to execute');
  }

  return getKernelInstanceById(options.instanceId)
    .then(client => client.execute(text));
}

function onGetAutoComplete(options, text, cursorPos) {
  return getKernelInstanceById(options.instanceId)
    .then(client => client.getAutoComplete(text, cursorPos))
    .timeout(autoCompleteTimeout * second, 'AutoComplete failed to finish in ' + autoCompleteTimeout + ' seconds');
}

function onIsComplete(options, text) {
  return getKernelInstanceById(options.instanceId)
    .then(client => client.isComplete(text));
}

function onGetInspection(options, text, cursorPos) {
  return getKernelInstanceById(options.instanceId)
    .then(client => client.getInspection(text, cursorPos));
}

function onGetStatus(options) {
  return getKernelInstanceById(options.instanceId)
    .then(client => client.getStatus());
}

function onExecuteHidden(options, code, resolveEvent) {
  return getKernelInstanceById(options.instanceId)
    .then(client => client.executeHidden(code, resolveEvent));
}

function onEval(options, text) {
  return getKernelInstanceById(options.instanceId)
    .then(client => client.getEval(text));
}

function onInterrupt(options) {
  return getKernelInstanceById(options.instanceId)
    .then(client => client.interrupt());
}

/**
 * To allow testing, the user can specific '--no-pythons' to prevent auto-detection of all the pythons
 * @returns {Promise}
 */
function findPythons() {
  if (argv.pythons === false) {
    return [];
  } else {
    return steveIrwin.findPythons(steveIrwin.getFacts());
  }
}

/**
 * Get system facts that the client-side hopefully caches and doesn't call repeatedly.
 *
 * These values should remain somewhat static on a particular machine
 * (unless something big has changed, like installing a new python or changing a home directory)
 *
 * @returns {Promise<object>}
 */
function onGetSystemFacts() {
  return bluebird.props({
    availablePythonKernels: findPythons(),
    homedir: os.homedir(),
    pathSep: path.sep,
    delimiter: path.delimiter
  }).timeout(systemFactTimeout * second, 'Unable to call "get system facts" in under ' + systemFactTimeout + ' seconds');
}

/**
 * @returns {Promise<string>}
 */
function onGetAppVersion() {
  const app = electron.app;

  return bluebird.resolve(app.getVersion());
}

/**
 * @returns {Promise<string>}
 */
function onGetAppName() {
  const app = electron.app;

  return bluebird.resolve(app.getName());
}

/**
 * @returns {Promise<string>}
 */
function onGetAppLocale() {
  const app = electron.app;

  return bluebird.resolve(app.getLocale());
}

/**
 * @returns {Promise}
 */
function onQuitAndInstall() {
  return bluebird.try(updater.install);
}

/**
 * We must be able to discover our current version to determine if we should update.
 * @returns {Promise}
 */
function onCheckForUpdates() {
  const pkg = getPkg();

  if (!pkg) {
    log('error', 'Unable to find package.json');
    return bluebird.resolve();
  }

  if (!pkg.version) {
    log('error', 'Unable to find version in package.json', pkg);
    return bluebird.resolve();
  }

  return bluebird.try(() => updater.update(pkg.version));
}

/**
 * Open browser (not in Electron)
 * @param {string} url
 */
function onOpenExternal(url) {
  const shell = electron.shell;

  log('debug', 'opening in default browser', url);

  shell.openExternal(url);
}

/**
 * Open terminal (based on their OS)
 */
function onOpenTerminal() {
  const shell = electron.shell,
    isWindows = process.platform === 'win32';

  log('debug', 'opening terminal');

  // todo: obviously, this may go badly on linux
  shell.openItem(isWindows ? 'cmd.exe' : '/Applications/Utilities/Terminal.app');
}

/**
 * @param {string} windowName
 * @returns {Promise}
 */
function onCloseWindow(windowName) {
  if (windowName) {
    const window = browserWindows.getByName(windowName);

    if (window) {
      window.close();
      return bluebird.resolve();
    } else {
      log('warn', 'tried to close non-existent window', windowName);
      return bluebird.reject(new Error('tried to close non-existent window ' + windowName));
    }
  } else {
    log('warn', 'tried to close window without saying name');
    return bluebird.reject(new Error('tried to close window without saying name'));
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {string} [options.defaultPath]
 * @param {object} [options.properties]
 * @param {Array} [options.filters]
 * @returns {Promise}
 * @example onOpenDialog({ title: 'Select your Python', properties: ['openFile'] })
 */
function onOpenDialog(options) {
  options = _.pick(options || {}, ['title', 'defaultPath', 'properties', 'filters']);

  return new bluebird(function (resolve) {
    electron.dialog.showOpenDialog(options, resolve);
  });
}

/**
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {string} [options.defaultPath]
 * @param {Array} [options.filters]
 * @returns {Promise}
 * @example onSaveDialog({ title: 'Save your Python' })
 */
function onSaveDialog(options) {
  options = _.pick(options || {}, ['title', 'defaultPath', 'filters']);

  return new bluebird(function (resolve) {
    electron.dialog.showSaveDialog(options, resolve);
  });
}

/**
 * Toggles the dev tools
 * @returns {Promise}
 */
function onToggleDevTools() {
  const currentWindow = this;

  return new bluebird(function (resolve) {
    currentWindow.toggleDevTools();
    resolve();
  });
}

/**
 * Toggles full screen mode
 * @returns {Promise}
 */
function onToggleFullScreen() {
  return new bluebird(function (resolve) {
    const currentWindow = this,
      isFull = currentWindow.isFullScreen();

    currentWindow.setFullScreen(!isFull);
    resolve();
  });
}

/**
 * @param {string} name
 * @param {object} options
 * @returns {BrowserWindow}
 */
function onCreateWindow(name, options) {
  // prefix url with our location
  if (!options.url) {
    throw new Error('Missing url for createWindow');
  }

  if (!windowUrls[options.url]) {
    throw new Error('Cannot find window entry point for ' + options.url);
  }

  options.url = 'file://' + path.join(staticFileDir, windowUrls[options.url]);

  const window = browserWindows.create(name, options);

  if (argv.dev === true) {
    window.openDevTools();
  }

  return window;
}

function onFinishStartup() {
  const startupWindow = browserWindows.getByName('startupWindow');

  if (startupWindow) {
    isStartupFinished = true;
    startupWindow.close();
  }
}

/**
 * Share an action with every window except the window that send the action.
 * @param {object} action
 */
function onShareAction(action) {
  const names = browserWindows.getWindowNames(),
    sender = this,
    senderName = _.find(names, function (name) {
      const window = browserWindows.getByName(name);

      return window && window.webContents === sender;
    });

  action.senderName = senderName;

  _.each(names, function (name) {
    if (name !== senderName) {
      browserWindows.send(name, 'sharedAction', action);
    }
  });
}

/**
 * Attaches events to the main process
 */
function attachIpcMainEvents() {
  const ipcMain = electron.ipcMain;

  ipcPromises.exposeElectronIpcEvents(ipcMain, [
    onExecute,
    onCheckForUpdates,
    onCheckKernel,
    onCloseWindow,
    onCreateKernelInstance,
    onCreateWindow,
    onFinishStartup,
    onEval,
    onExecuteHidden,
    onFiles,
    onFileStats,
    onGetAppVersion,
    onGetAppName,
    onGetAppLocale,
    onGetAutoComplete,
    onGetFile,
    onGetInspection,
    onGetSystemFacts,
    onGetStatus,
    onIsComplete,
    onInterrupt,
    onKnitHTML,
    onQuitApplication,
    onPDF,
    onResolveFilePath,
    onSaveFile,
    onShareAction,
    onQuitAndInstall,
    onOpenExternal,
    onOpenTerminal,
    onOpenDialog,
    onSaveDialog,
    onToggleDevTools,
    onToggleFullScreen,
    onKillKernelInstance
  ]);
}

function startApp() {
  const app = electron.app,
    appUserModelId = 'com.squirrel.rodeo.Rodeo';

  if (app) {
    app.setAppUserModelId(appUserModelId);

    // record for later use
    log('info', 'started with', argv, process.argv);
    log('info', 'versions', process.versions);

    return installer.handleSquirrelStartupEvent(app)
      .then(function (isSquirrel) {
        if (!isSquirrel) {
          attachAppEvents();
          return startPlotServer();
        } else {
          log('info', 'was squirrely');
        }
      })
      .catch(error => log('error', error));
  }
}

/**
 * Attach events only if we're not in a browser window
 */
function attachAppEvents() {
  const app = electron.app;

  app.on('will-finish-launching', function () {
    log('info', 'will-finish-launching');
  });
  app.on('will-quit', function () {
    log('info', 'will-quit');
  });
  app.on('before-quit', function () {
    log('info', 'before-quit');
  });
  app.on('quit', function (event, errorCode) {
    log('info', 'quit', {errorCode});
  });
  app.on('activate', function (event, hasVisibleWindows) {
    log('info', 'activate', {hasVisibleWindows});
  });
  app.on('gpu-process-crashed', function () {
    log('info', 'gpu-process-crashed');
  });
  app.on('window-all-closed', onWindowAllClosed);
  app.on('ready', onReady);
}

function startPlotServer() {
  plotServerInstance = new PlotServer(Math.floor(Math.random() * 2000) + 8000);

  return plotServerInstance.listen()
    .then(port => log('info', 'serving plots from port', port))
    .catch(error => log('critical', 'failure to start plot server', error));
}

/**
 * @param {EventEmitter} ipcEmitter
 * @returns {Promise}
 */
function attachApplicationMenu(ipcEmitter) {
  const Menu = electron.Menu;

  return menuDefinitions.getByName('application').then(function (definition) {
    return menuDefinitions.toElectronMenuTemplate(ipcEmitter, definition);
  }).then(function (menuTemplate) {
    const menu = Menu.buildFromTemplate(menuTemplate);

    Menu.setApplicationMenu(menu);
  });
}

module.exports.onCloseWindow = onCloseWindow;
module.exports.onFiles = onFiles;
module.exports.onPDF = onPDF;
module.exports.onQuitApplication = onQuitApplication;
module.exports.onReady = onReady;
module.exports.onWindowAllClosed = onWindowAllClosed;

startApp();
