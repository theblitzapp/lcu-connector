const { EventEmitter } = require('events');
const fs = require('fs-extra');
const path = require('path');
const chokidar = require('chokidar');
const cp = require('child_process');
const LockfileParser = require('lol-lockfile-parser');

const lockfile = new LockfileParser();
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

class LCUConnector extends EventEmitter {

  static getLCUPathFromProcess() {
    return new Promise((resolve, reject) => {
      const INSTALL_REGEX_WIN = /"--install-directory=(.*?)"/;
      const INSTALL_REGEX_MAC = /--install-directory=(.*?)( --|\n|$)/;
      const INSTALL_REGEX = IS_WIN ? INSTALL_REGEX_WIN : INSTALL_REGEX_MAC;
      const command = IS_WIN ?
        `WMIC PROCESS WHERE name='LeagueClientUx.exe' GET commandline` :
        `ps x -o args | grep 'LeagueClientUx'`;

      cp.exec(command, (err, stdout, stderr) => {
        if (err) {
          reject(err);
        }
        if (!stdout) {
          reject(new Error("Invalid stdout from WMIC: " + stdout));
        }
        if (stderr) {
          reject(stderr);
        }

        const parts = stdout.match(INSTALL_REGEX);
        if (parts) {
          resolve(parts[1]);
        } else {
          reject(new Error("Failed to match regex: " + stdout));
        }
      });
    });
  }

  static isValidLCUPath(dirPath) {
    if (!dirPath) {
      return false;
    }

    const lcuClientApp = IS_MAC ? 'LeagueClient.app' : 'LeagueClient.exe';
    const common = fs.existsSync(path.join(dirPath, lcuClientApp)) && fs.existsSync(path.join(dirPath, 'Config'));
    const isGlobal = common && fs.existsSync(path.join(dirPath, 'RADS'));
    const isCN = common && fs.existsSync(path.join(dirPath, 'TQM'));
    const isGarena = common; // Garena has no other

    return isGlobal || isCN || isGarena;
  }

  constructor(executablePath = 'C:\\Riot Games\\League of Legends\\LeagueClient.exe') {
    super();
    console.log("lcu-connector [CONSTRUCTOR]")

    this._dirPath = path.dirname(path.normalize(executablePath));
  }

  start() {
    console.log("lcu-connector [START]")

    if (LCUConnector.isValidLCUPath(this._dirPath)) {
      this._initLockfileWatcher();
      return;
    }

    this._initProcessWatcher();
  }

  stop() {
    console.log("lcu-connector [STOP]")
    this._clearProcessWatcher();
    this._clearLockfileWatcher();
  }

  _initLockfileWatcher() {
    if (this._lockfileWatcher) {
      return;
    }

    const lockfilePath = path.join(this._dirPath, 'lockfile');
    this._lockfileWatcher = chokidar.watch(lockfilePath, {
      disableGlobbing: true,
      ignoreInitial: false,
      awaitWriteFinish: true
    });

    this._lockfileWatcher.on('add', this._onFileCreated.bind(this));
    this._lockfileWatcher.on('change', this._onFileCreated.bind(this));
    this._lockfileWatcher.on('unlink', this._onFileRemoved.bind(this));
    this._lockfileWatcher.on('error', this._onError.bind(this));
  }

  _clearLockfileWatcher() {
    if (this._lockfileWatcher) {
      this._lockfileWatcher.close();
    }
  }

  _initProcessWatcher() {
    return LCUConnector.getLCUPathFromProcess()
    .then(lcuPath => {
      if (lcuPath) {
        this._dirPath = lcuPath;
        this._clearProcessWatcher();
        this._initLockfileWatcher();
        return;
      }

      if (!this._processWatcher) {
        this._processWatcher = setInterval(this._initProcessWatcher.bind(this), 1000);
      }
    })
    .catch((err) => {
      this.emit('error', err);
      if (!this._processWatcher) {
        this._processWatcher = setInterval(this._initProcessWatcher.bind(this), 1000);
      }
    });
  }

  _clearProcessWatcher() {
    clearInterval(this._processWatcher);
  }

  _onFileCreated(lockfilePath) {
    fs.access(lockfilePath, fs.constants.R_OK, (err) => {
      if (err) {
        this._onError(err)
      } else {
        let lockfileContent = fs.readFileSync(lockfilePath).toString();
        if (lockfileContent !== '') {
          lockfile.read(lockfilePath).then(data => {
            if (data) {
              const result = {
                protocol: data.protocol || 'https',
                address: '127.0.0.1',
                port: data.port,
                username: 'riot',
                password: data.password
              };
              this.emit('connect', result);
            }
          });
        } else {
          // if the file is empty, we try to read it after sometime
          this._retryRead(lockfilePath);
        }
      }
    });
  }

  _retryRead(lockfilePath) {
    setTimeout(() => {
      lockfile.read(lockfilePath).then(data => {
        if (data) {
          const result = {
            protocol: data.protocol || 'https',
            address: '127.0.0.1',
            port: data.port,
            username: 'riot',
            password: data.password
          };
          this.emit('connect', result);
        }
      });
    }, 1000);
  }

  _onError(error) {
    console.log("lcu-connector [ERROR] ", error)
    this.emit('error', error);
  }

  _onFileRemoved() {
    console.log("lcu-connector [DISCONNECT]")
    this.emit('disconnect');
  }

}

module.exports = LCUConnector;
