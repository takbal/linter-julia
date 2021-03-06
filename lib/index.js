/* @flow */

import net from 'net';
import FS from 'fs';
import { CompositeDisposable } from 'atom';
import { spawnServer, getPipePath } from './server';

const pipepath = getPipePath();

let subscriptions: ?Object = null;

let executablePath;
let ignoreInfo;
let ignoreWarning;
let showErrorCodes;
let ignoreIssueCodes;

function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pipeup() {
  if (!FS.existsSync(pipepath)) {
    await timeout(1000);
    await pipeup();
  }
}

async function unlock() {
  if (global.linter_julia_locked === true) {
    await timeout(200);
    await unlock();
    return;
  }
  global.linter_julia_locked = true;
}

export function activate() {
  // eslint-disable-next-line global-require
  require('atom-package-deps').install('linter-julia');
  subscriptions = new CompositeDisposable();
  subscriptions.add(
    atom.config.observe('linter-julia.executablePath', async (value) => {
      executablePath = value;
      // taken out: terminateServer() just does not work for some reason
      /*
      if (global.linter_julia_spawnedServer) {
        try {
          await terminateServer(global.linter_julia_spawnedServer);
          global.linter_julia_spawnedServer = spawnServer(executablePath);
          global.linter_julia_started = true;
          global.linter_julia_locked = false;
          atom.notifications.addInfo(
            'linter-julia: it is likely safer to restart Atom after this change');
        } catch (e) {
          const message = '[Linter-Julia] '
            + 'Unable to spawn server after config change';
          atom.notifications.addError(`${message}. See console for details.`);
          // eslint-disable-next-line no-console
          console.error(`${message}: `, e);
        }
       }
       */
      if (global.linter_julia_started) {
        atom.notifications.addInfo('[Linter-Julia] please restart Atom for this change to work');
      }
    }),
    atom.config.observe('linter-julia.ignoreInfo', (value) => {
      ignoreInfo = value;
    }),
    atom.config.observe('linter-julia.ignoreWarning', (value) => {
      ignoreWarning = value;
    }),
    atom.config.observe('linter-julia.showErrorCodes', (value) => {
      showErrorCodes = value;
    }),
    atom.config.observe('linter-julia.ignoreIssueCodes', (value) => {
      ignoreIssueCodes = value;
    }),
  );

  // start only one server
  if (typeof global.linter_julia_started === 'undefined') {
    global.linter_julia_spawnedServer = spawnServer(executablePath);
    global.linter_julia_started = true;
    global.linter_julia_locked = false;
  }
}

export function deactivate() {
  if (global.linter_julia_spawnedServer !== null) {
    // terminateServer() just does not work
    // terminateServer(global.linter_julia_spawnedServer);
    // global.linter_julia_spawnedServer = null;
    // global.linter_julia_started = false;
    // server stays alive, just try not to deadlock
    global.linter_julia_locked = false;
  }
  if (subscriptions) {
    subscriptions.dispose();
  }
}

export function provideLinter() {
  return {
    name: 'Julia',
    scope: 'file',
    lintsOnChange: true,
    grammarScopes: ['source.julia'],
    async lint(textEditor: Object) {
      // wait for the pipe to appear
      await pipeup();

      // only one connection at one time
      await unlock();

      const connection = net.createConnection(pipepath);

      connection.on('connect', function writeData() {
        this.write(JSON.stringify({
          file: textEditor.getPath(),
          code_str: textEditor.getText(),
          show_code: showErrorCodes,
          ignore_info: ignoreInfo,
          ignore_codes: ignoreIssueCodes,
          ignore_warnings: ignoreWarning,
        }));
      });

      return new Promise(((resolve, reject) => {
        setTimeout(() => {
          // This is the timeout because net.Socket doesn't have one for connections
          reject(new Error('Request timed out'));
          connection.end();
        }, 300 * 1000);
        connection.on('error', reject);

        const data = [];
        connection.on('data', (chunk) => {
          data.push(chunk);
        });
        connection.on('close', () => {
          let parsed;
          const merged = data.join('');
          try {
            parsed = JSON.parse(merged);
          } catch (_) {
            atom.notifications.addError(`[Linter-Julia] server has likely crashed. Please check symbolserver.log.${process.pid}
              in the "linter-julia" shared Julia environment, and restart Atom.`);
            // eslint-disable-next-line no-console
            console.error('server returned: ', merged);
            resolve(null);
            return;
          }
          if (parsed.length > 0) {
            if (parsed[0].description === 'I000') {
              atom.notifications.addInfo(`[Linter-Julia] generating symbols for the environment ${parsed[0].excerpt}, please wait ...`);
              parsed = [];
            }
          }

          global.linter_julia_locked = false;
          resolve(parsed);
        });
      }));
    },
  };
}
