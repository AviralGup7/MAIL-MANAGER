/**
 * The service worker, at the EXTENSION ROOT.
 *
 * WHY IT LIVES HERE AND NOT IN src/background/
 * --------------------------------------------
 * Chrome refused to register the worker with "Service worker registration
 * failed. Status code: 2" -- an error naming no file, no line and no cause.
 * Every static check passed. The break came from calling
 * navigator.serviceWorker.register() by hand in the browser, which returns
 * what Chrome hides:
 *
 *   AbortError: Failed to register a ServiceWorker for scope
 *   ('chrome-extension://<id>/src/background/') with script
 *   ('chrome-extension://<id>/src/background/boot.js'):
 *   Operation has been aborted
 *
 * The scope is the tell. A service worker's default scope is its own
 * DIRECTORY, so a script at /src/background/boot.js is scoped to
 * /src/background/ -- it can only control that subtree. An extension worker
 * has to control the whole extension origin.
 *
 * Chrome normally special-cases the manifest's `service_worker` and registers
 * it at "/" wherever the file sits. That exemption has been unreliable across
 * builds, and on this machine it is not holding. Putting the file at the root
 * makes the default scope "/" and removes the dependency on the exemption
 * entirely.
 *
 * The cost is one file in the project root. The benefit is that the most
 * fragile assumption in the whole load path is gone.
 *
 * This file deliberately contains NO logic. It re-exports the real boot
 * sequence so that everything stays testable where it already lives, and so
 * that this file has nothing in it that could itself fail.
 */

import './src/background/boot.js';
