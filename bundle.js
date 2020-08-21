(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
"use strict";

// rawAsap provides everything we need except exception management.
var rawAsap = require("./raw");
// RawTasks are recycled to reduce GC churn.
var freeTasks = [];
// We queue errors to ensure they are thrown in right order (FIFO).
// Array-as-queue is good enough here, since we are just dealing with exceptions.
var pendingErrors = [];
var requestErrorThrow = rawAsap.makeRequestCallFromTimer(throwFirstError);

function throwFirstError() {
    if (pendingErrors.length) {
        throw pendingErrors.shift();
    }
}

/**
 * Calls a task as soon as possible after returning, in its own event, with priority
 * over other events like animation, reflow, and repaint. An error thrown from an
 * event will not interrupt, nor even substantially slow down the processing of
 * other events, but will be rather postponed to a lower priority event.
 * @param {{call}} task A callable object, typically a function that takes no
 * arguments.
 */
module.exports = asap;
function asap(task) {
    var rawTask;
    if (freeTasks.length) {
        rawTask = freeTasks.pop();
    } else {
        rawTask = new RawTask();
    }
    rawTask.task = task;
    rawAsap(rawTask);
}

// We wrap tasks with recyclable task objects.  A task object implements
// `call`, just like a function.
function RawTask() {
    this.task = null;
}

// The sole purpose of wrapping the task is to catch the exception and recycle
// the task object after its single use.
RawTask.prototype.call = function () {
    try {
        this.task.call();
    } catch (error) {
        if (asap.onerror) {
            // This hook exists purely for testing purposes.
            // Its name will be periodically randomized to break any code that
            // depends on its existence.
            asap.onerror(error);
        } else {
            // In a web browser, exceptions are not fatal. However, to avoid
            // slowing down the queue of pending tasks, we rethrow the error in a
            // lower priority turn.
            pendingErrors.push(error);
            requestErrorThrow();
        }
    } finally {
        this.task = null;
        freeTasks[freeTasks.length] = this;
    }
};

},{"./raw":2}],2:[function(require,module,exports){
(function (global){
"use strict";

// Use the fastest means possible to execute a task in its own turn, with
// priority over other events including IO, animation, reflow, and redraw
// events in browsers.
//
// An exception thrown by a task will permanently interrupt the processing of
// subsequent tasks. The higher level `asap` function ensures that if an
// exception is thrown by a task, that the task queue will continue flushing as
// soon as possible, but if you use `rawAsap` directly, you are responsible to
// either ensure that no exceptions are thrown from your task, or to manually
// call `rawAsap.requestFlush` if an exception is thrown.
module.exports = rawAsap;
function rawAsap(task) {
    if (!queue.length) {
        requestFlush();
        flushing = true;
    }
    // Equivalent to push, but avoids a function call.
    queue[queue.length] = task;
}

var queue = [];
// Once a flush has been requested, no further calls to `requestFlush` are
// necessary until the next `flush` completes.
var flushing = false;
// `requestFlush` is an implementation-specific method that attempts to kick
// off a `flush` event as quickly as possible. `flush` will attempt to exhaust
// the event queue before yielding to the browser's own event loop.
var requestFlush;
// The position of the next task to execute in the task queue. This is
// preserved between calls to `flush` so that it can be resumed if
// a task throws an exception.
var index = 0;
// If a task schedules additional tasks recursively, the task queue can grow
// unbounded. To prevent memory exhaustion, the task queue will periodically
// truncate already-completed tasks.
var capacity = 1024;

// The flush function processes all tasks that have been scheduled with
// `rawAsap` unless and until one of those tasks throws an exception.
// If a task throws an exception, `flush` ensures that its state will remain
// consistent and will resume where it left off when called again.
// However, `flush` does not make any arrangements to be called again if an
// exception is thrown.
function flush() {
    while (index < queue.length) {
        var currentIndex = index;
        // Advance the index before calling the task. This ensures that we will
        // begin flushing on the next task the task throws an error.
        index = index + 1;
        queue[currentIndex].call();
        // Prevent leaking memory for long chains of recursive calls to `asap`.
        // If we call `asap` within tasks scheduled by `asap`, the queue will
        // grow, but to avoid an O(n) walk for every task we execute, we don't
        // shift tasks off the queue after they have been executed.
        // Instead, we periodically shift 1024 tasks off the queue.
        if (index > capacity) {
            // Manually shift all values starting at the index back to the
            // beginning of the queue.
            for (var scan = 0, newLength = queue.length - index; scan < newLength; scan++) {
                queue[scan] = queue[scan + index];
            }
            queue.length -= index;
            index = 0;
        }
    }
    queue.length = 0;
    index = 0;
    flushing = false;
}

// `requestFlush` is implemented using a strategy based on data collected from
// every available SauceLabs Selenium web driver worker at time of writing.
// https://docs.google.com/spreadsheets/d/1mG-5UYGup5qxGdEMWkhP6BWCz053NUb2E1QoUTU16uA/edit#gid=783724593

// Safari 6 and 6.1 for desktop, iPad, and iPhone are the only browsers that
// have WebKitMutationObserver but not un-prefixed MutationObserver.
// Must use `global` or `self` instead of `window` to work in both frames and web
// workers. `global` is a provision of Browserify, Mr, Mrs, or Mop.

/* globals self */
var scope = typeof global !== "undefined" ? global : self;
var BrowserMutationObserver = scope.MutationObserver || scope.WebKitMutationObserver;

// MutationObservers are desirable because they have high priority and work
// reliably everywhere they are implemented.
// They are implemented in all modern browsers.
//
// - Android 4-4.3
// - Chrome 26-34
// - Firefox 14-29
// - Internet Explorer 11
// - iPad Safari 6-7.1
// - iPhone Safari 7-7.1
// - Safari 6-7
if (typeof BrowserMutationObserver === "function") {
    requestFlush = makeRequestCallFromMutationObserver(flush);

// MessageChannels are desirable because they give direct access to the HTML
// task queue, are implemented in Internet Explorer 10, Safari 5.0-1, and Opera
// 11-12, and in web workers in many engines.
// Although message channels yield to any queued rendering and IO tasks, they
// would be better than imposing the 4ms delay of timers.
// However, they do not work reliably in Internet Explorer or Safari.

// Internet Explorer 10 is the only browser that has setImmediate but does
// not have MutationObservers.
// Although setImmediate yields to the browser's renderer, it would be
// preferrable to falling back to setTimeout since it does not have
// the minimum 4ms penalty.
// Unfortunately there appears to be a bug in Internet Explorer 10 Mobile (and
// Desktop to a lesser extent) that renders both setImmediate and
// MessageChannel useless for the purposes of ASAP.
// https://github.com/kriskowal/q/issues/396

// Timers are implemented universally.
// We fall back to timers in workers in most engines, and in foreground
// contexts in the following browsers.
// However, note that even this simple case requires nuances to operate in a
// broad spectrum of browsers.
//
// - Firefox 3-13
// - Internet Explorer 6-9
// - iPad Safari 4.3
// - Lynx 2.8.7
} else {
    requestFlush = makeRequestCallFromTimer(flush);
}

// `requestFlush` requests that the high priority event queue be flushed as
// soon as possible.
// This is useful to prevent an error thrown in a task from stalling the event
// queue if the exception handled by Node.js’s
// `process.on("uncaughtException")` or by a domain.
rawAsap.requestFlush = requestFlush;

// To request a high priority event, we induce a mutation observer by toggling
// the text of a text node between "1" and "-1".
function makeRequestCallFromMutationObserver(callback) {
    var toggle = 1;
    var observer = new BrowserMutationObserver(callback);
    var node = document.createTextNode("");
    observer.observe(node, {characterData: true});
    return function requestCall() {
        toggle = -toggle;
        node.data = toggle;
    };
}

// The message channel technique was discovered by Malte Ubl and was the
// original foundation for this library.
// http://www.nonblocking.io/2011/06/windownexttick.html

// Safari 6.0.5 (at least) intermittently fails to create message ports on a
// page's first load. Thankfully, this version of Safari supports
// MutationObservers, so we don't need to fall back in that case.

// function makeRequestCallFromMessageChannel(callback) {
//     var channel = new MessageChannel();
//     channel.port1.onmessage = callback;
//     return function requestCall() {
//         channel.port2.postMessage(0);
//     };
// }

// For reasons explained above, we are also unable to use `setImmediate`
// under any circumstances.
// Even if we were, there is another bug in Internet Explorer 10.
// It is not sufficient to assign `setImmediate` to `requestFlush` because
// `setImmediate` must be called *by name* and therefore must be wrapped in a
// closure.
// Never forget.

// function makeRequestCallFromSetImmediate(callback) {
//     return function requestCall() {
//         setImmediate(callback);
//     };
// }

// Safari 6.0 has a problem where timers will get lost while the user is
// scrolling. This problem does not impact ASAP because Safari 6.0 supports
// mutation observers, so that implementation is used instead.
// However, if we ever elect to use timers in Safari, the prevalent work-around
// is to add a scroll event listener that calls for a flush.

// `setTimeout` does not call the passed callback if the delay is less than
// approximately 7 in web workers in Firefox 8 through 18, and sometimes not
// even then.

function makeRequestCallFromTimer(callback) {
    return function requestCall() {
        // We dispatch a timeout with a specified delay of 0 for engines that
        // can reliably accommodate that request. This will usually be snapped
        // to a 4 milisecond delay, but once we're flushing, there's no delay
        // between events.
        var timeoutHandle = setTimeout(handleTimer, 0);
        // However, since this timer gets frequently dropped in Firefox
        // workers, we enlist an interval handle that will try to fire
        // an event 20 times per second until it succeeds.
        var intervalHandle = setInterval(handleTimer, 50);

        function handleTimer() {
            // Whichever timer succeeds will cancel both timers and
            // execute the callback.
            clearTimeout(timeoutHandle);
            clearInterval(intervalHandle);
            callback();
        }
    };
}

// This is for `asap.js` only.
// Its name will be periodically randomized to break any code that depends on
// its existence.
rawAsap.makeRequestCallFromTimer = makeRequestCallFromTimer;

// ASAP was originally a nextTick shim included in Q. This was factored out
// into this ASAP package. It was later adapted to RSVP which made further
// amendments. These decisions, particularly to marginalize MessageChannel and
// to capture the MutationObserver implementation in a closure, were integrated
// back into ASAP proper.
// https://github.com/tildeio/rsvp.js/blob/cddf7232546a9cf858524b75cde6f9edf72620a7/lib/rsvp/asap.js

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],3:[function(require,module,exports){
module.exports = require('./lib/axios');
},{"./lib/axios":5}],4:[function(require,module,exports){
'use strict';

var utils = require('./../utils');
var settle = require('./../core/settle');
var buildURL = require('./../helpers/buildURL');
var buildFullPath = require('../core/buildFullPath');
var parseHeaders = require('./../helpers/parseHeaders');
var isURLSameOrigin = require('./../helpers/isURLSameOrigin');
var createError = require('../core/createError');

module.exports = function xhrAdapter(config) {
  return new Promise(function dispatchXhrRequest(resolve, reject) {
    var requestData = config.data;
    var requestHeaders = config.headers;

    if (utils.isFormData(requestData)) {
      delete requestHeaders['Content-Type']; // Let the browser set it
    }

    var request = new XMLHttpRequest();

    // HTTP basic authentication
    if (config.auth) {
      var username = config.auth.username || '';
      var password = config.auth.password || '';
      requestHeaders.Authorization = 'Basic ' + btoa(username + ':' + password);
    }

    var fullPath = buildFullPath(config.baseURL, config.url);
    request.open(config.method.toUpperCase(), buildURL(fullPath, config.params, config.paramsSerializer), true);

    // Set the request timeout in MS
    request.timeout = config.timeout;

    // Listen for ready state
    request.onreadystatechange = function handleLoad() {
      if (!request || request.readyState !== 4) {
        return;
      }

      // The request errored out and we didn't get a response, this will be
      // handled by onerror instead
      // With one exception: request that using file: protocol, most browsers
      // will return status as 0 even though it's a successful request
      if (request.status === 0 && !(request.responseURL && request.responseURL.indexOf('file:') === 0)) {
        return;
      }

      // Prepare the response
      var responseHeaders = 'getAllResponseHeaders' in request ? parseHeaders(request.getAllResponseHeaders()) : null;
      var responseData = !config.responseType || config.responseType === 'text' ? request.responseText : request.response;
      var response = {
        data: responseData,
        status: request.status,
        statusText: request.statusText,
        headers: responseHeaders,
        config: config,
        request: request
      };

      settle(resolve, reject, response);

      // Clean up request
      request = null;
    };

    // Handle browser request cancellation (as opposed to a manual cancellation)
    request.onabort = function handleAbort() {
      if (!request) {
        return;
      }

      reject(createError('Request aborted', config, 'ECONNABORTED', request));

      // Clean up request
      request = null;
    };

    // Handle low level network errors
    request.onerror = function handleError() {
      // Real errors are hidden from us by the browser
      // onerror should only fire if it's a network error
      reject(createError('Network Error', config, null, request));

      // Clean up request
      request = null;
    };

    // Handle timeout
    request.ontimeout = function handleTimeout() {
      var timeoutErrorMessage = 'timeout of ' + config.timeout + 'ms exceeded';
      if (config.timeoutErrorMessage) {
        timeoutErrorMessage = config.timeoutErrorMessage;
      }
      reject(createError(timeoutErrorMessage, config, 'ECONNABORTED',
        request));

      // Clean up request
      request = null;
    };

    // Add xsrf header
    // This is only done if running in a standard browser environment.
    // Specifically not if we're in a web worker, or react-native.
    if (utils.isStandardBrowserEnv()) {
      var cookies = require('./../helpers/cookies');

      // Add xsrf header
      var xsrfValue = (config.withCredentials || isURLSameOrigin(fullPath)) && config.xsrfCookieName ?
        cookies.read(config.xsrfCookieName) :
        undefined;

      if (xsrfValue) {
        requestHeaders[config.xsrfHeaderName] = xsrfValue;
      }
    }

    // Add headers to the request
    if ('setRequestHeader' in request) {
      utils.forEach(requestHeaders, function setRequestHeader(val, key) {
        if (typeof requestData === 'undefined' && key.toLowerCase() === 'content-type') {
          // Remove Content-Type if data is undefined
          delete requestHeaders[key];
        } else {
          // Otherwise add header to the request
          request.setRequestHeader(key, val);
        }
      });
    }

    // Add withCredentials to request if needed
    if (!utils.isUndefined(config.withCredentials)) {
      request.withCredentials = !!config.withCredentials;
    }

    // Add responseType to request if needed
    if (config.responseType) {
      try {
        request.responseType = config.responseType;
      } catch (e) {
        // Expected DOMException thrown by browsers not compatible XMLHttpRequest Level 2.
        // But, this can be suppressed for 'json' type as it can be parsed by default 'transformResponse' function.
        if (config.responseType !== 'json') {
          throw e;
        }
      }
    }

    // Handle progress if needed
    if (typeof config.onDownloadProgress === 'function') {
      request.addEventListener('progress', config.onDownloadProgress);
    }

    // Not all browsers support upload events
    if (typeof config.onUploadProgress === 'function' && request.upload) {
      request.upload.addEventListener('progress', config.onUploadProgress);
    }

    if (config.cancelToken) {
      // Handle cancellation
      config.cancelToken.promise.then(function onCanceled(cancel) {
        if (!request) {
          return;
        }

        request.abort();
        reject(cancel);
        // Clean up request
        request = null;
      });
    }

    if (requestData === undefined) {
      requestData = null;
    }

    // Send the request
    request.send(requestData);
  });
};

},{"../core/buildFullPath":11,"../core/createError":12,"./../core/settle":16,"./../helpers/buildURL":20,"./../helpers/cookies":22,"./../helpers/isURLSameOrigin":24,"./../helpers/parseHeaders":26,"./../utils":28}],5:[function(require,module,exports){
'use strict';

var utils = require('./utils');
var bind = require('./helpers/bind');
var Axios = require('./core/Axios');
var mergeConfig = require('./core/mergeConfig');
var defaults = require('./defaults');

/**
 * Create an instance of Axios
 *
 * @param {Object} defaultConfig The default config for the instance
 * @return {Axios} A new instance of Axios
 */
function createInstance(defaultConfig) {
  var context = new Axios(defaultConfig);
  var instance = bind(Axios.prototype.request, context);

  // Copy axios.prototype to instance
  utils.extend(instance, Axios.prototype, context);

  // Copy context to instance
  utils.extend(instance, context);

  return instance;
}

// Create the default instance to be exported
var axios = createInstance(defaults);

// Expose Axios class to allow class inheritance
axios.Axios = Axios;

// Factory for creating new instances
axios.create = function create(instanceConfig) {
  return createInstance(mergeConfig(axios.defaults, instanceConfig));
};

// Expose Cancel & CancelToken
axios.Cancel = require('./cancel/Cancel');
axios.CancelToken = require('./cancel/CancelToken');
axios.isCancel = require('./cancel/isCancel');

// Expose all/spread
axios.all = function all(promises) {
  return Promise.all(promises);
};
axios.spread = require('./helpers/spread');

module.exports = axios;

// Allow use of default import syntax in TypeScript
module.exports.default = axios;

},{"./cancel/Cancel":6,"./cancel/CancelToken":7,"./cancel/isCancel":8,"./core/Axios":9,"./core/mergeConfig":15,"./defaults":18,"./helpers/bind":19,"./helpers/spread":27,"./utils":28}],6:[function(require,module,exports){
'use strict';

/**
 * A `Cancel` is an object that is thrown when an operation is canceled.
 *
 * @class
 * @param {string=} message The message.
 */
function Cancel(message) {
  this.message = message;
}

Cancel.prototype.toString = function toString() {
  return 'Cancel' + (this.message ? ': ' + this.message : '');
};

Cancel.prototype.__CANCEL__ = true;

module.exports = Cancel;

},{}],7:[function(require,module,exports){
'use strict';

var Cancel = require('./Cancel');

/**
 * A `CancelToken` is an object that can be used to request cancellation of an operation.
 *
 * @class
 * @param {Function} executor The executor function.
 */
function CancelToken(executor) {
  if (typeof executor !== 'function') {
    throw new TypeError('executor must be a function.');
  }

  var resolvePromise;
  this.promise = new Promise(function promiseExecutor(resolve) {
    resolvePromise = resolve;
  });

  var token = this;
  executor(function cancel(message) {
    if (token.reason) {
      // Cancellation has already been requested
      return;
    }

    token.reason = new Cancel(message);
    resolvePromise(token.reason);
  });
}

/**
 * Throws a `Cancel` if cancellation has been requested.
 */
CancelToken.prototype.throwIfRequested = function throwIfRequested() {
  if (this.reason) {
    throw this.reason;
  }
};

/**
 * Returns an object that contains a new `CancelToken` and a function that, when called,
 * cancels the `CancelToken`.
 */
CancelToken.source = function source() {
  var cancel;
  var token = new CancelToken(function executor(c) {
    cancel = c;
  });
  return {
    token: token,
    cancel: cancel
  };
};

module.exports = CancelToken;

},{"./Cancel":6}],8:[function(require,module,exports){
'use strict';

module.exports = function isCancel(value) {
  return !!(value && value.__CANCEL__);
};

},{}],9:[function(require,module,exports){
'use strict';

var utils = require('./../utils');
var buildURL = require('../helpers/buildURL');
var InterceptorManager = require('./InterceptorManager');
var dispatchRequest = require('./dispatchRequest');
var mergeConfig = require('./mergeConfig');

/**
 * Create a new instance of Axios
 *
 * @param {Object} instanceConfig The default config for the instance
 */
function Axios(instanceConfig) {
  this.defaults = instanceConfig;
  this.interceptors = {
    request: new InterceptorManager(),
    response: new InterceptorManager()
  };
}

/**
 * Dispatch a request
 *
 * @param {Object} config The config specific for this request (merged with this.defaults)
 */
Axios.prototype.request = function request(config) {
  /*eslint no-param-reassign:0*/
  // Allow for axios('example/url'[, config]) a la fetch API
  if (typeof config === 'string') {
    config = arguments[1] || {};
    config.url = arguments[0];
  } else {
    config = config || {};
  }

  config = mergeConfig(this.defaults, config);

  // Set config.method
  if (config.method) {
    config.method = config.method.toLowerCase();
  } else if (this.defaults.method) {
    config.method = this.defaults.method.toLowerCase();
  } else {
    config.method = 'get';
  }

  // Hook up interceptors middleware
  var chain = [dispatchRequest, undefined];
  var promise = Promise.resolve(config);

  this.interceptors.request.forEach(function unshiftRequestInterceptors(interceptor) {
    chain.unshift(interceptor.fulfilled, interceptor.rejected);
  });

  this.interceptors.response.forEach(function pushResponseInterceptors(interceptor) {
    chain.push(interceptor.fulfilled, interceptor.rejected);
  });

  while (chain.length) {
    promise = promise.then(chain.shift(), chain.shift());
  }

  return promise;
};

Axios.prototype.getUri = function getUri(config) {
  config = mergeConfig(this.defaults, config);
  return buildURL(config.url, config.params, config.paramsSerializer).replace(/^\?/, '');
};

// Provide aliases for supported request methods
utils.forEach(['delete', 'get', 'head', 'options'], function forEachMethodNoData(method) {
  /*eslint func-names:0*/
  Axios.prototype[method] = function(url, config) {
    return this.request(utils.merge(config || {}, {
      method: method,
      url: url
    }));
  };
});

utils.forEach(['post', 'put', 'patch'], function forEachMethodWithData(method) {
  /*eslint func-names:0*/
  Axios.prototype[method] = function(url, data, config) {
    return this.request(utils.merge(config || {}, {
      method: method,
      url: url,
      data: data
    }));
  };
});

module.exports = Axios;

},{"../helpers/buildURL":20,"./../utils":28,"./InterceptorManager":10,"./dispatchRequest":13,"./mergeConfig":15}],10:[function(require,module,exports){
'use strict';

var utils = require('./../utils');

function InterceptorManager() {
  this.handlers = [];
}

/**
 * Add a new interceptor to the stack
 *
 * @param {Function} fulfilled The function to handle `then` for a `Promise`
 * @param {Function} rejected The function to handle `reject` for a `Promise`
 *
 * @return {Number} An ID used to remove interceptor later
 */
InterceptorManager.prototype.use = function use(fulfilled, rejected) {
  this.handlers.push({
    fulfilled: fulfilled,
    rejected: rejected
  });
  return this.handlers.length - 1;
};

/**
 * Remove an interceptor from the stack
 *
 * @param {Number} id The ID that was returned by `use`
 */
InterceptorManager.prototype.eject = function eject(id) {
  if (this.handlers[id]) {
    this.handlers[id] = null;
  }
};

/**
 * Iterate over all the registered interceptors
 *
 * This method is particularly useful for skipping over any
 * interceptors that may have become `null` calling `eject`.
 *
 * @param {Function} fn The function to call for each interceptor
 */
InterceptorManager.prototype.forEach = function forEach(fn) {
  utils.forEach(this.handlers, function forEachHandler(h) {
    if (h !== null) {
      fn(h);
    }
  });
};

module.exports = InterceptorManager;

},{"./../utils":28}],11:[function(require,module,exports){
'use strict';

var isAbsoluteURL = require('../helpers/isAbsoluteURL');
var combineURLs = require('../helpers/combineURLs');

/**
 * Creates a new URL by combining the baseURL with the requestedURL,
 * only when the requestedURL is not already an absolute URL.
 * If the requestURL is absolute, this function returns the requestedURL untouched.
 *
 * @param {string} baseURL The base URL
 * @param {string} requestedURL Absolute or relative URL to combine
 * @returns {string} The combined full path
 */
module.exports = function buildFullPath(baseURL, requestedURL) {
  if (baseURL && !isAbsoluteURL(requestedURL)) {
    return combineURLs(baseURL, requestedURL);
  }
  return requestedURL;
};

},{"../helpers/combineURLs":21,"../helpers/isAbsoluteURL":23}],12:[function(require,module,exports){
'use strict';

var enhanceError = require('./enhanceError');

/**
 * Create an Error with the specified message, config, error code, request and response.
 *
 * @param {string} message The error message.
 * @param {Object} config The config.
 * @param {string} [code] The error code (for example, 'ECONNABORTED').
 * @param {Object} [request] The request.
 * @param {Object} [response] The response.
 * @returns {Error} The created error.
 */
module.exports = function createError(message, config, code, request, response) {
  var error = new Error(message);
  return enhanceError(error, config, code, request, response);
};

},{"./enhanceError":14}],13:[function(require,module,exports){
'use strict';

var utils = require('./../utils');
var transformData = require('./transformData');
var isCancel = require('../cancel/isCancel');
var defaults = require('../defaults');

/**
 * Throws a `Cancel` if cancellation has been requested.
 */
function throwIfCancellationRequested(config) {
  if (config.cancelToken) {
    config.cancelToken.throwIfRequested();
  }
}

/**
 * Dispatch a request to the server using the configured adapter.
 *
 * @param {object} config The config that is to be used for the request
 * @returns {Promise} The Promise to be fulfilled
 */
module.exports = function dispatchRequest(config) {
  throwIfCancellationRequested(config);

  // Ensure headers exist
  config.headers = config.headers || {};

  // Transform request data
  config.data = transformData(
    config.data,
    config.headers,
    config.transformRequest
  );

  // Flatten headers
  config.headers = utils.merge(
    config.headers.common || {},
    config.headers[config.method] || {},
    config.headers
  );

  utils.forEach(
    ['delete', 'get', 'head', 'post', 'put', 'patch', 'common'],
    function cleanHeaderConfig(method) {
      delete config.headers[method];
    }
  );

  var adapter = config.adapter || defaults.adapter;

  return adapter(config).then(function onAdapterResolution(response) {
    throwIfCancellationRequested(config);

    // Transform response data
    response.data = transformData(
      response.data,
      response.headers,
      config.transformResponse
    );

    return response;
  }, function onAdapterRejection(reason) {
    if (!isCancel(reason)) {
      throwIfCancellationRequested(config);

      // Transform response data
      if (reason && reason.response) {
        reason.response.data = transformData(
          reason.response.data,
          reason.response.headers,
          config.transformResponse
        );
      }
    }

    return Promise.reject(reason);
  });
};

},{"../cancel/isCancel":8,"../defaults":18,"./../utils":28,"./transformData":17}],14:[function(require,module,exports){
'use strict';

/**
 * Update an Error with the specified config, error code, and response.
 *
 * @param {Error} error The error to update.
 * @param {Object} config The config.
 * @param {string} [code] The error code (for example, 'ECONNABORTED').
 * @param {Object} [request] The request.
 * @param {Object} [response] The response.
 * @returns {Error} The error.
 */
module.exports = function enhanceError(error, config, code, request, response) {
  error.config = config;
  if (code) {
    error.code = code;
  }

  error.request = request;
  error.response = response;
  error.isAxiosError = true;

  error.toJSON = function() {
    return {
      // Standard
      message: this.message,
      name: this.name,
      // Microsoft
      description: this.description,
      number: this.number,
      // Mozilla
      fileName: this.fileName,
      lineNumber: this.lineNumber,
      columnNumber: this.columnNumber,
      stack: this.stack,
      // Axios
      config: this.config,
      code: this.code
    };
  };
  return error;
};

},{}],15:[function(require,module,exports){
'use strict';

var utils = require('../utils');

/**
 * Config-specific merge-function which creates a new config-object
 * by merging two configuration objects together.
 *
 * @param {Object} config1
 * @param {Object} config2
 * @returns {Object} New object resulting from merging config2 to config1
 */
module.exports = function mergeConfig(config1, config2) {
  // eslint-disable-next-line no-param-reassign
  config2 = config2 || {};
  var config = {};

  var valueFromConfig2Keys = ['url', 'method', 'params', 'data'];
  var mergeDeepPropertiesKeys = ['headers', 'auth', 'proxy'];
  var defaultToConfig2Keys = [
    'baseURL', 'url', 'transformRequest', 'transformResponse', 'paramsSerializer',
    'timeout', 'withCredentials', 'adapter', 'responseType', 'xsrfCookieName',
    'xsrfHeaderName', 'onUploadProgress', 'onDownloadProgress',
    'maxContentLength', 'validateStatus', 'maxRedirects', 'httpAgent',
    'httpsAgent', 'cancelToken', 'socketPath'
  ];

  utils.forEach(valueFromConfig2Keys, function valueFromConfig2(prop) {
    if (typeof config2[prop] !== 'undefined') {
      config[prop] = config2[prop];
    }
  });

  utils.forEach(mergeDeepPropertiesKeys, function mergeDeepProperties(prop) {
    if (utils.isObject(config2[prop])) {
      config[prop] = utils.deepMerge(config1[prop], config2[prop]);
    } else if (typeof config2[prop] !== 'undefined') {
      config[prop] = config2[prop];
    } else if (utils.isObject(config1[prop])) {
      config[prop] = utils.deepMerge(config1[prop]);
    } else if (typeof config1[prop] !== 'undefined') {
      config[prop] = config1[prop];
    }
  });

  utils.forEach(defaultToConfig2Keys, function defaultToConfig2(prop) {
    if (typeof config2[prop] !== 'undefined') {
      config[prop] = config2[prop];
    } else if (typeof config1[prop] !== 'undefined') {
      config[prop] = config1[prop];
    }
  });

  var axiosKeys = valueFromConfig2Keys
    .concat(mergeDeepPropertiesKeys)
    .concat(defaultToConfig2Keys);

  var otherKeys = Object
    .keys(config2)
    .filter(function filterAxiosKeys(key) {
      return axiosKeys.indexOf(key) === -1;
    });

  utils.forEach(otherKeys, function otherKeysDefaultToConfig2(prop) {
    if (typeof config2[prop] !== 'undefined') {
      config[prop] = config2[prop];
    } else if (typeof config1[prop] !== 'undefined') {
      config[prop] = config1[prop];
    }
  });

  return config;
};

},{"../utils":28}],16:[function(require,module,exports){
'use strict';

var createError = require('./createError');

/**
 * Resolve or reject a Promise based on response status.
 *
 * @param {Function} resolve A function that resolves the promise.
 * @param {Function} reject A function that rejects the promise.
 * @param {object} response The response.
 */
module.exports = function settle(resolve, reject, response) {
  var validateStatus = response.config.validateStatus;
  if (!validateStatus || validateStatus(response.status)) {
    resolve(response);
  } else {
    reject(createError(
      'Request failed with status code ' + response.status,
      response.config,
      null,
      response.request,
      response
    ));
  }
};

},{"./createError":12}],17:[function(require,module,exports){
'use strict';

var utils = require('./../utils');

/**
 * Transform the data for a request or a response
 *
 * @param {Object|String} data The data to be transformed
 * @param {Array} headers The headers for the request or response
 * @param {Array|Function} fns A single function or Array of functions
 * @returns {*} The resulting transformed data
 */
module.exports = function transformData(data, headers, fns) {
  /*eslint no-param-reassign:0*/
  utils.forEach(fns, function transform(fn) {
    data = fn(data, headers);
  });

  return data;
};

},{"./../utils":28}],18:[function(require,module,exports){
(function (process){
'use strict';

var utils = require('./utils');
var normalizeHeaderName = require('./helpers/normalizeHeaderName');

var DEFAULT_CONTENT_TYPE = {
  'Content-Type': 'application/x-www-form-urlencoded'
};

function setContentTypeIfUnset(headers, value) {
  if (!utils.isUndefined(headers) && utils.isUndefined(headers['Content-Type'])) {
    headers['Content-Type'] = value;
  }
}

function getDefaultAdapter() {
  var adapter;
  if (typeof XMLHttpRequest !== 'undefined') {
    // For browsers use XHR adapter
    adapter = require('./adapters/xhr');
  } else if (typeof process !== 'undefined' && Object.prototype.toString.call(process) === '[object process]') {
    // For node use HTTP adapter
    adapter = require('./adapters/http');
  }
  return adapter;
}

var defaults = {
  adapter: getDefaultAdapter(),

  transformRequest: [function transformRequest(data, headers) {
    normalizeHeaderName(headers, 'Accept');
    normalizeHeaderName(headers, 'Content-Type');
    if (utils.isFormData(data) ||
      utils.isArrayBuffer(data) ||
      utils.isBuffer(data) ||
      utils.isStream(data) ||
      utils.isFile(data) ||
      utils.isBlob(data)
    ) {
      return data;
    }
    if (utils.isArrayBufferView(data)) {
      return data.buffer;
    }
    if (utils.isURLSearchParams(data)) {
      setContentTypeIfUnset(headers, 'application/x-www-form-urlencoded;charset=utf-8');
      return data.toString();
    }
    if (utils.isObject(data)) {
      setContentTypeIfUnset(headers, 'application/json;charset=utf-8');
      return JSON.stringify(data);
    }
    return data;
  }],

  transformResponse: [function transformResponse(data) {
    /*eslint no-param-reassign:0*/
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (e) { /* Ignore */ }
    }
    return data;
  }],

  /**
   * A timeout in milliseconds to abort a request. If set to 0 (default) a
   * timeout is not created.
   */
  timeout: 0,

  xsrfCookieName: 'XSRF-TOKEN',
  xsrfHeaderName: 'X-XSRF-TOKEN',

  maxContentLength: -1,

  validateStatus: function validateStatus(status) {
    return status >= 200 && status < 300;
  }
};

defaults.headers = {
  common: {
    'Accept': 'application/json, text/plain, */*'
  }
};

utils.forEach(['delete', 'get', 'head'], function forEachMethodNoData(method) {
  defaults.headers[method] = {};
});

utils.forEach(['post', 'put', 'patch'], function forEachMethodWithData(method) {
  defaults.headers[method] = utils.merge(DEFAULT_CONTENT_TYPE);
});

module.exports = defaults;

}).call(this,require('_process'))
},{"./adapters/http":4,"./adapters/xhr":4,"./helpers/normalizeHeaderName":25,"./utils":28,"_process":48}],19:[function(require,module,exports){
'use strict';

module.exports = function bind(fn, thisArg) {
  return function wrap() {
    var args = new Array(arguments.length);
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }
    return fn.apply(thisArg, args);
  };
};

},{}],20:[function(require,module,exports){
'use strict';

var utils = require('./../utils');

function encode(val) {
  return encodeURIComponent(val).
    replace(/%40/gi, '@').
    replace(/%3A/gi, ':').
    replace(/%24/g, '$').
    replace(/%2C/gi, ',').
    replace(/%20/g, '+').
    replace(/%5B/gi, '[').
    replace(/%5D/gi, ']');
}

/**
 * Build a URL by appending params to the end
 *
 * @param {string} url The base of the url (e.g., http://www.google.com)
 * @param {object} [params] The params to be appended
 * @returns {string} The formatted url
 */
module.exports = function buildURL(url, params, paramsSerializer) {
  /*eslint no-param-reassign:0*/
  if (!params) {
    return url;
  }

  var serializedParams;
  if (paramsSerializer) {
    serializedParams = paramsSerializer(params);
  } else if (utils.isURLSearchParams(params)) {
    serializedParams = params.toString();
  } else {
    var parts = [];

    utils.forEach(params, function serialize(val, key) {
      if (val === null || typeof val === 'undefined') {
        return;
      }

      if (utils.isArray(val)) {
        key = key + '[]';
      } else {
        val = [val];
      }

      utils.forEach(val, function parseValue(v) {
        if (utils.isDate(v)) {
          v = v.toISOString();
        } else if (utils.isObject(v)) {
          v = JSON.stringify(v);
        }
        parts.push(encode(key) + '=' + encode(v));
      });
    });

    serializedParams = parts.join('&');
  }

  if (serializedParams) {
    var hashmarkIndex = url.indexOf('#');
    if (hashmarkIndex !== -1) {
      url = url.slice(0, hashmarkIndex);
    }

    url += (url.indexOf('?') === -1 ? '?' : '&') + serializedParams;
  }

  return url;
};

},{"./../utils":28}],21:[function(require,module,exports){
'use strict';

/**
 * Creates a new URL by combining the specified URLs
 *
 * @param {string} baseURL The base URL
 * @param {string} relativeURL The relative URL
 * @returns {string} The combined URL
 */
module.exports = function combineURLs(baseURL, relativeURL) {
  return relativeURL
    ? baseURL.replace(/\/+$/, '') + '/' + relativeURL.replace(/^\/+/, '')
    : baseURL;
};

},{}],22:[function(require,module,exports){
'use strict';

var utils = require('./../utils');

module.exports = (
  utils.isStandardBrowserEnv() ?

  // Standard browser envs support document.cookie
    (function standardBrowserEnv() {
      return {
        write: function write(name, value, expires, path, domain, secure) {
          var cookie = [];
          cookie.push(name + '=' + encodeURIComponent(value));

          if (utils.isNumber(expires)) {
            cookie.push('expires=' + new Date(expires).toGMTString());
          }

          if (utils.isString(path)) {
            cookie.push('path=' + path);
          }

          if (utils.isString(domain)) {
            cookie.push('domain=' + domain);
          }

          if (secure === true) {
            cookie.push('secure');
          }

          document.cookie = cookie.join('; ');
        },

        read: function read(name) {
          var match = document.cookie.match(new RegExp('(^|;\\s*)(' + name + ')=([^;]*)'));
          return (match ? decodeURIComponent(match[3]) : null);
        },

        remove: function remove(name) {
          this.write(name, '', Date.now() - 86400000);
        }
      };
    })() :

  // Non standard browser env (web workers, react-native) lack needed support.
    (function nonStandardBrowserEnv() {
      return {
        write: function write() {},
        read: function read() { return null; },
        remove: function remove() {}
      };
    })()
);

},{"./../utils":28}],23:[function(require,module,exports){
'use strict';

/**
 * Determines whether the specified URL is absolute
 *
 * @param {string} url The URL to test
 * @returns {boolean} True if the specified URL is absolute, otherwise false
 */
module.exports = function isAbsoluteURL(url) {
  // A URL is considered absolute if it begins with "<scheme>://" or "//" (protocol-relative URL).
  // RFC 3986 defines scheme name as a sequence of characters beginning with a letter and followed
  // by any combination of letters, digits, plus, period, or hyphen.
  return /^([a-z][a-z\d\+\-\.]*:)?\/\//i.test(url);
};

},{}],24:[function(require,module,exports){
'use strict';

var utils = require('./../utils');

module.exports = (
  utils.isStandardBrowserEnv() ?

  // Standard browser envs have full support of the APIs needed to test
  // whether the request URL is of the same origin as current location.
    (function standardBrowserEnv() {
      var msie = /(msie|trident)/i.test(navigator.userAgent);
      var urlParsingNode = document.createElement('a');
      var originURL;

      /**
    * Parse a URL to discover it's components
    *
    * @param {String} url The URL to be parsed
    * @returns {Object}
    */
      function resolveURL(url) {
        var href = url;

        if (msie) {
        // IE needs attribute set twice to normalize properties
          urlParsingNode.setAttribute('href', href);
          href = urlParsingNode.href;
        }

        urlParsingNode.setAttribute('href', href);

        // urlParsingNode provides the UrlUtils interface - http://url.spec.whatwg.org/#urlutils
        return {
          href: urlParsingNode.href,
          protocol: urlParsingNode.protocol ? urlParsingNode.protocol.replace(/:$/, '') : '',
          host: urlParsingNode.host,
          search: urlParsingNode.search ? urlParsingNode.search.replace(/^\?/, '') : '',
          hash: urlParsingNode.hash ? urlParsingNode.hash.replace(/^#/, '') : '',
          hostname: urlParsingNode.hostname,
          port: urlParsingNode.port,
          pathname: (urlParsingNode.pathname.charAt(0) === '/') ?
            urlParsingNode.pathname :
            '/' + urlParsingNode.pathname
        };
      }

      originURL = resolveURL(window.location.href);

      /**
    * Determine if a URL shares the same origin as the current location
    *
    * @param {String} requestURL The URL to test
    * @returns {boolean} True if URL shares the same origin, otherwise false
    */
      return function isURLSameOrigin(requestURL) {
        var parsed = (utils.isString(requestURL)) ? resolveURL(requestURL) : requestURL;
        return (parsed.protocol === originURL.protocol &&
            parsed.host === originURL.host);
      };
    })() :

  // Non standard browser envs (web workers, react-native) lack needed support.
    (function nonStandardBrowserEnv() {
      return function isURLSameOrigin() {
        return true;
      };
    })()
);

},{"./../utils":28}],25:[function(require,module,exports){
'use strict';

var utils = require('../utils');

module.exports = function normalizeHeaderName(headers, normalizedName) {
  utils.forEach(headers, function processHeader(value, name) {
    if (name !== normalizedName && name.toUpperCase() === normalizedName.toUpperCase()) {
      headers[normalizedName] = value;
      delete headers[name];
    }
  });
};

},{"../utils":28}],26:[function(require,module,exports){
'use strict';

var utils = require('./../utils');

// Headers whose duplicates are ignored by node
// c.f. https://nodejs.org/api/http.html#http_message_headers
var ignoreDuplicateOf = [
  'age', 'authorization', 'content-length', 'content-type', 'etag',
  'expires', 'from', 'host', 'if-modified-since', 'if-unmodified-since',
  'last-modified', 'location', 'max-forwards', 'proxy-authorization',
  'referer', 'retry-after', 'user-agent'
];

/**
 * Parse headers into an object
 *
 * ```
 * Date: Wed, 27 Aug 2014 08:58:49 GMT
 * Content-Type: application/json
 * Connection: keep-alive
 * Transfer-Encoding: chunked
 * ```
 *
 * @param {String} headers Headers needing to be parsed
 * @returns {Object} Headers parsed into an object
 */
module.exports = function parseHeaders(headers) {
  var parsed = {};
  var key;
  var val;
  var i;

  if (!headers) { return parsed; }

  utils.forEach(headers.split('\n'), function parser(line) {
    i = line.indexOf(':');
    key = utils.trim(line.substr(0, i)).toLowerCase();
    val = utils.trim(line.substr(i + 1));

    if (key) {
      if (parsed[key] && ignoreDuplicateOf.indexOf(key) >= 0) {
        return;
      }
      if (key === 'set-cookie') {
        parsed[key] = (parsed[key] ? parsed[key] : []).concat([val]);
      } else {
        parsed[key] = parsed[key] ? parsed[key] + ', ' + val : val;
      }
    }
  });

  return parsed;
};

},{"./../utils":28}],27:[function(require,module,exports){
'use strict';

/**
 * Syntactic sugar for invoking a function and expanding an array for arguments.
 *
 * Common use case would be to use `Function.prototype.apply`.
 *
 *  ```js
 *  function f(x, y, z) {}
 *  var args = [1, 2, 3];
 *  f.apply(null, args);
 *  ```
 *
 * With `spread` this example can be re-written.
 *
 *  ```js
 *  spread(function(x, y, z) {})([1, 2, 3]);
 *  ```
 *
 * @param {Function} callback
 * @returns {Function}
 */
module.exports = function spread(callback) {
  return function wrap(arr) {
    return callback.apply(null, arr);
  };
};

},{}],28:[function(require,module,exports){
'use strict';

var bind = require('./helpers/bind');

/*global toString:true*/

// utils is a library of generic helper functions non-specific to axios

var toString = Object.prototype.toString;

/**
 * Determine if a value is an Array
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is an Array, otherwise false
 */
function isArray(val) {
  return toString.call(val) === '[object Array]';
}

/**
 * Determine if a value is undefined
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if the value is undefined, otherwise false
 */
function isUndefined(val) {
  return typeof val === 'undefined';
}

/**
 * Determine if a value is a Buffer
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a Buffer, otherwise false
 */
function isBuffer(val) {
  return val !== null && !isUndefined(val) && val.constructor !== null && !isUndefined(val.constructor)
    && typeof val.constructor.isBuffer === 'function' && val.constructor.isBuffer(val);
}

/**
 * Determine if a value is an ArrayBuffer
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is an ArrayBuffer, otherwise false
 */
function isArrayBuffer(val) {
  return toString.call(val) === '[object ArrayBuffer]';
}

/**
 * Determine if a value is a FormData
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is an FormData, otherwise false
 */
function isFormData(val) {
  return (typeof FormData !== 'undefined') && (val instanceof FormData);
}

/**
 * Determine if a value is a view on an ArrayBuffer
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a view on an ArrayBuffer, otherwise false
 */
function isArrayBufferView(val) {
  var result;
  if ((typeof ArrayBuffer !== 'undefined') && (ArrayBuffer.isView)) {
    result = ArrayBuffer.isView(val);
  } else {
    result = (val) && (val.buffer) && (val.buffer instanceof ArrayBuffer);
  }
  return result;
}

/**
 * Determine if a value is a String
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a String, otherwise false
 */
function isString(val) {
  return typeof val === 'string';
}

/**
 * Determine if a value is a Number
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a Number, otherwise false
 */
function isNumber(val) {
  return typeof val === 'number';
}

/**
 * Determine if a value is an Object
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is an Object, otherwise false
 */
function isObject(val) {
  return val !== null && typeof val === 'object';
}

/**
 * Determine if a value is a Date
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a Date, otherwise false
 */
function isDate(val) {
  return toString.call(val) === '[object Date]';
}

/**
 * Determine if a value is a File
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a File, otherwise false
 */
function isFile(val) {
  return toString.call(val) === '[object File]';
}

/**
 * Determine if a value is a Blob
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a Blob, otherwise false
 */
function isBlob(val) {
  return toString.call(val) === '[object Blob]';
}

/**
 * Determine if a value is a Function
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a Function, otherwise false
 */
function isFunction(val) {
  return toString.call(val) === '[object Function]';
}

/**
 * Determine if a value is a Stream
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a Stream, otherwise false
 */
function isStream(val) {
  return isObject(val) && isFunction(val.pipe);
}

/**
 * Determine if a value is a URLSearchParams object
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a URLSearchParams object, otherwise false
 */
function isURLSearchParams(val) {
  return typeof URLSearchParams !== 'undefined' && val instanceof URLSearchParams;
}

/**
 * Trim excess whitespace off the beginning and end of a string
 *
 * @param {String} str The String to trim
 * @returns {String} The String freed of excess whitespace
 */
function trim(str) {
  return str.replace(/^\s*/, '').replace(/\s*$/, '');
}

/**
 * Determine if we're running in a standard browser environment
 *
 * This allows axios to run in a web worker, and react-native.
 * Both environments support XMLHttpRequest, but not fully standard globals.
 *
 * web workers:
 *  typeof window -> undefined
 *  typeof document -> undefined
 *
 * react-native:
 *  navigator.product -> 'ReactNative'
 * nativescript
 *  navigator.product -> 'NativeScript' or 'NS'
 */
function isStandardBrowserEnv() {
  if (typeof navigator !== 'undefined' && (navigator.product === 'ReactNative' ||
                                           navigator.product === 'NativeScript' ||
                                           navigator.product === 'NS')) {
    return false;
  }
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined'
  );
}

/**
 * Iterate over an Array or an Object invoking a function for each item.
 *
 * If `obj` is an Array callback will be called passing
 * the value, index, and complete array for each item.
 *
 * If 'obj' is an Object callback will be called passing
 * the value, key, and complete object for each property.
 *
 * @param {Object|Array} obj The object to iterate
 * @param {Function} fn The callback to invoke for each item
 */
function forEach(obj, fn) {
  // Don't bother if no value provided
  if (obj === null || typeof obj === 'undefined') {
    return;
  }

  // Force an array if not already something iterable
  if (typeof obj !== 'object') {
    /*eslint no-param-reassign:0*/
    obj = [obj];
  }

  if (isArray(obj)) {
    // Iterate over array values
    for (var i = 0, l = obj.length; i < l; i++) {
      fn.call(null, obj[i], i, obj);
    }
  } else {
    // Iterate over object keys
    for (var key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        fn.call(null, obj[key], key, obj);
      }
    }
  }
}

/**
 * Accepts varargs expecting each argument to be an object, then
 * immutably merges the properties of each object and returns result.
 *
 * When multiple objects contain the same key the later object in
 * the arguments list will take precedence.
 *
 * Example:
 *
 * ```js
 * var result = merge({foo: 123}, {foo: 456});
 * console.log(result.foo); // outputs 456
 * ```
 *
 * @param {Object} obj1 Object to merge
 * @returns {Object} Result of all merge properties
 */
function merge(/* obj1, obj2, obj3, ... */) {
  var result = {};
  function assignValue(val, key) {
    if (typeof result[key] === 'object' && typeof val === 'object') {
      result[key] = merge(result[key], val);
    } else {
      result[key] = val;
    }
  }

  for (var i = 0, l = arguments.length; i < l; i++) {
    forEach(arguments[i], assignValue);
  }
  return result;
}

/**
 * Function equal to merge with the difference being that no reference
 * to original objects is kept.
 *
 * @see merge
 * @param {Object} obj1 Object to merge
 * @returns {Object} Result of all merge properties
 */
function deepMerge(/* obj1, obj2, obj3, ... */) {
  var result = {};
  function assignValue(val, key) {
    if (typeof result[key] === 'object' && typeof val === 'object') {
      result[key] = deepMerge(result[key], val);
    } else if (typeof val === 'object') {
      result[key] = deepMerge({}, val);
    } else {
      result[key] = val;
    }
  }

  for (var i = 0, l = arguments.length; i < l; i++) {
    forEach(arguments[i], assignValue);
  }
  return result;
}

/**
 * Extends object a by mutably adding to it the properties of object b.
 *
 * @param {Object} a The object to be extended
 * @param {Object} b The object to copy properties from
 * @param {Object} thisArg The object to bind function to
 * @return {Object} The resulting value of object a
 */
function extend(a, b, thisArg) {
  forEach(b, function assignValue(val, key) {
    if (thisArg && typeof val === 'function') {
      a[key] = bind(val, thisArg);
    } else {
      a[key] = val;
    }
  });
  return a;
}

module.exports = {
  isArray: isArray,
  isArrayBuffer: isArrayBuffer,
  isBuffer: isBuffer,
  isFormData: isFormData,
  isArrayBufferView: isArrayBufferView,
  isString: isString,
  isNumber: isNumber,
  isObject: isObject,
  isUndefined: isUndefined,
  isDate: isDate,
  isFile: isFile,
  isBlob: isBlob,
  isFunction: isFunction,
  isStream: isStream,
  isURLSearchParams: isURLSearchParams,
  isStandardBrowserEnv: isStandardBrowserEnv,
  forEach: forEach,
  merge: merge,
  deepMerge: deepMerge,
  extend: extend,
  trim: trim
};

},{"./helpers/bind":19}],29:[function(require,module,exports){
(function (process,global){
'use strict';

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var axios = require('axios');

var _require = require('./helpers'),
    checkType = _require.checkType;

var Models = require('./Models');
var Inputs = require('./Inputs');
var Concepts = require('./Concepts');
var Workflow = require('./Workflow');
var Workflows = require('./Workflows');
var Solutions = require('./solutions/Solutions');

var _require2 = require('./constants'),
    API = _require2.API,
    ERRORS = _require2.ERRORS,
    getBasePath = _require2.getBasePath;

var TOKEN_PATH = API.TOKEN_PATH;


if (typeof window !== 'undefined' && !('Promise' in window)) {
  window.Promise = require('promise');
}

if (typeof global !== 'undefined' && !('Promise' in global)) {
  global.Promise = require('promise');
}

/**
 * top-level class that allows access to models, inputs and concepts
 * @class
 */

var App = function () {
  function App(arg1, arg2, arg3) {
    _classCallCheck(this, App);

    var optionsObj = arg1;
    if ((typeof arg1 === 'undefined' ? 'undefined' : _typeof(arg1)) !== 'object' || arg1 === null) {
      optionsObj = arg3 || {};
      optionsObj.clientId = arg1;
      optionsObj.clientSecret = arg2;
    }
    this._validate(optionsObj);
    this._init(optionsObj);
  }

  /**
   * Gets a token from the API using client credentials
   * @return {Promise(token, error)} A Promise that is fulfilled with the token string or rejected with an error
   *
   * @deprecated Please switch to using the API key.
   */


  _createClass(App, [{
    key: 'getToken',
    value: function getToken() {
      return this._config.token();
    }

    /**
     * Sets the token to use for the API
     * @param {String}         _token    The token you are setting
     * @return {Boolean}                 true if token has valid fields, false if not
     *
     * @deprecated Please switch to using the API key.
     */

  }, {
    key: 'setToken',
    value: function setToken(_token) {
      var token = _token;
      var now = new Date().getTime();
      if (typeof _token === 'string') {
        token = {
          accessToken: _token,
          expiresIn: 176400
        };
      } else {
        token = {
          accessToken: _token.access_token || _token.accessToken,
          expiresIn: _token.expires_in || _token.expiresIn
        };
      }
      if (token.accessToken && token.expiresIn || token.access_token && token.expires_in) {
        if (!token.expireTime) {
          token.expireTime = now + token.expiresIn * 1000;
        }
        this._config._token = token;
        return true;
      }
      return false;
    }
  }, {
    key: '_validate',
    value: function _validate(_ref) {
      var clientId = _ref.clientId,
          clientSecret = _ref.clientSecret,
          token = _ref.token,
          apiKey = _ref.apiKey,
          sessionToken = _ref.sessionToken;

      if (clientId || clientSecret) {
        console.warn('Client ID/secret has been deprecated. Please switch to using the API key. See here how to do ' + 'the switch: https://blog.clarifai.com/introducing-api-keys-a-safer-way-to-authenticate-your-applications');
      }
      if ((!clientId || !clientSecret) && !token && !apiKey && !sessionToken) {
        throw ERRORS.paramsRequired(['apiKey']);
      }
    }
  }, {
    key: '_init',
    value: function _init(options) {
      var _this = this;

      var apiEndpoint = options.apiEndpoint || process && process.env && process.env.API_ENDPOINT || 'https://api.clarifai.com';
      this._config = {
        apiEndpoint: apiEndpoint,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        apiKey: options.apiKey,
        sessionToken: options.sessionToken,
        basePath: getBasePath(apiEndpoint, options.userId, options.appId),
        token: function token() {
          return new Promise(function (resolve, reject) {
            var now = new Date().getTime();
            if (checkType(/Object/, _this._config._token) && _this._config._token.expireTime > now) {
              resolve(_this._config._token);
            } else {
              _this._getToken(resolve, reject);
            }
          });
        }
      };
      if (options.token) {
        this.setToken(options.token);
      }
      this.models = new Models(this._config);
      this.inputs = new Inputs(this._config);
      this.concepts = new Concepts(this._config);
      this.workflow = new Workflow(this._config);
      this.workflows = new Workflows(this._config);
      this.solutions = new Solutions(this._config);
    }

    /**
     * @deprecated Please switch to using the API key.
     */

  }, {
    key: '_getToken',
    value: function _getToken(resolve, reject) {
      var _this2 = this;

      this._requestToken().then(function (response) {
        if (response.status === 200) {
          _this2.setToken(response.data);
          resolve(_this2._config._token);
        } else {
          reject(response);
        }
      }, reject);
    }

    /**
     * @deprecated Please switch to using the API key.
     */

  }, {
    key: '_requestToken',
    value: function _requestToken() {
      var url = '' + this._config.basePath + TOKEN_PATH;
      var clientId = this._config.clientId;
      var clientSecret = this._config.clientSecret;
      return axios({
        'url': url,
        'method': 'POST',
        'auth': {
          'username': clientId,
          'password': clientSecret
        }
      });
    }
  }]);

  return App;
}();

module.exports = App;
}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./Concepts":31,"./Inputs":33,"./Models":36,"./Workflow":39,"./Workflows":40,"./constants":41,"./helpers":42,"./solutions/Solutions":45,"_process":48,"axios":3,"promise":49}],30:[function(require,module,exports){
"use strict";

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

/**
 * class representing a concept and its info
 * @class
 */
var Concept = function Concept(_config, data) {
  _classCallCheck(this, Concept);

  this.id = data.id;
  this.name = data.name;
  this.createdAt = data.created_at || data.createdAt;
  this.appId = data.app_id || data.appId;
  this.value = data.value || null;
  this._config = _config;
  this.rawData = data;
};

;

module.exports = Concept;
},{}],31:[function(require,module,exports){
'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var axios = require('axios');
var Concept = require('./Concept');

var _require = require('./constants'),
    API = _require.API,
    replaceVars = _require.replaceVars;

var CONCEPTS_PATH = API.CONCEPTS_PATH,
    CONCEPT_PATH = API.CONCEPT_PATH,
    CONCEPT_SEARCH_PATH = API.CONCEPT_SEARCH_PATH;

var _require2 = require('./utils'),
    wrapToken = _require2.wrapToken,
    formatConcept = _require2.formatConcept;

var _require3 = require('./helpers'),
    isSuccess = _require3.isSuccess,
    checkType = _require3.checkType;

/**
 * class representing a collection of concepts
 * @class
 */


var Concepts = function () {
  function Concepts(_config) {
    var _this = this;

    var rawData = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];

    _classCallCheck(this, Concepts);

    this._config = _config;
    this.rawData = rawData;
    rawData.forEach(function (conceptData, index) {
      _this[index] = new Concept(_this._config, conceptData);
    });
    this.length = rawData.length;
  }

  /**
   * List all the concepts
   * @param {object}     options     Object with keys explained below: (optional)
   *    @param {number}    options.page        The page number (optional, default: 1)
   *    @param {number}    options.perPage     Number of images to return per page (optional, default: 20)
   * @return {Promise(Concepts, error)} A Promise that is fulfilled with a Concepts instance or rejected with an error
   */


  _createClass(Concepts, [{
    key: 'list',
    value: function list() {
      var _this2 = this;

      var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : { page: 1, perPage: 20 };

      var url = '' + this._config.basePath + CONCEPTS_PATH;
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.get(url, {
            headers: headers,
            params: {
              'page': options.page,
              'per_page': options.perPage
            }
          }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Concepts(_this2._config, response.data.concepts));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }

    /**
     * List a single concept given an id
     * @param {String}     id          The concept's id
     * @return {Promise(Concept, error)} A Promise that is fulfilled with a Concept instance or rejected with an error
     */

  }, {
    key: 'get',
    value: function get(id) {
      var _this3 = this;

      var url = '' + this._config.basePath + replaceVars(CONCEPT_PATH, [id]);
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.get(url, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Concept(_this3._config, response.data.concept));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }

    /**
     * Add a list of concepts given an id and name
     * @param {object|object[]}   concepts       Can be a single media object or an array of media objects
     *   @param  {object|string}    concepts[].concept         If string, this is assumed to be the concept id. Otherwise, an object with the following attributes
     *     @param  {object}           concepts[].concept.id      The new concept's id (Required)
     *     @param  {object}           concepts[].concept.name    The new concept's name
     * @return {Promise(Concepts, error)}             A Promise that is fulfilled with a Concepts instance or rejected with an error
     */

  }, {
    key: 'create',
    value: function create() {
      var _this4 = this;

      var concepts = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : [];

      if (checkType(/(Object|String)/, concepts)) {
        concepts = [concepts];
      }
      var data = {
        'concepts': concepts.map(formatConcept)
      };
      var url = '' + this._config.basePath + CONCEPTS_PATH;
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.post(url, data, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Concepts(_this4._config, response.data.concepts));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }

    /**
     * Search for a concept given a name. A wildcard can be given (example: The name "bo*" will match with "boat" and "bow" given those concepts exist
     * @param  {string}   name  The name of the concept to search for
     * @return {Promise(Concepts, error)} A Promise that is fulfilled with a Concepts instance or rejected with an error
     */

  }, {
    key: 'search',
    value: function search(name) {
      var _this5 = this;

      var language = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;

      var url = '' + this._config.basePath + CONCEPT_SEARCH_PATH;
      return wrapToken(this._config, function (headers) {
        var params = {
          'concept_query': { name: name, language: language }
        };
        return new Promise(function (resolve, reject) {
          axios.post(url, params, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Concepts(_this5._config, response.data.concepts));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }

    /**
     * Update a concepts
     * @param {object|object[]}   concepts       Can be a single concept object or an array of concept objects
     *   @param  {object}           concepts[].concept         A concept object with the following attributes
     *     @param  {object}           concepts[].concept.id      The concept's id (Required)
     *     @param  {object}           concepts[].concept.name    The concept's new name
     * @param {string}            [action=overwrite]  The action to use for the PATCH
     * @return {Promise(Concepts, error)}             A Promise that is fulfilled with a Concepts instance or rejected with an error
     */

  }, {
    key: 'update',
    value: function update() {
      var _this6 = this;

      var concepts = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : [];
      var action = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 'overwrite';

      if (!checkType(/Array/, concepts)) {
        concepts = [concepts];
      }
      var data = {
        concepts: concepts,
        action: action
      };
      var url = '' + this._config.basePath + CONCEPTS_PATH;
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.patch(url, data, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Concepts(_this6._config, response.data.concepts));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }
  }]);

  return Concepts;
}();

;

module.exports = Concepts;
},{"./Concept":30,"./constants":41,"./helpers":42,"./utils":46,"axios":3}],32:[function(require,module,exports){
'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var axios = require('axios');
var Concepts = require('./Concepts');
var Regions = require('./Regions');

var _require = require('./constants'),
    API = _require.API;

var INPUTS_PATH = API.INPUTS_PATH;

/**
 * class representing an input
 * @class
 */

var Input = function () {
  function Input(_config, data) {
    _classCallCheck(this, Input);

    this.id = data.id;
    this.createdAt = data.created_at || data.createdAt;
    this.imageUrl = data.data.image.url;
    this.concepts = new Concepts(_config, data.data.concepts);
    this.regions = new Regions(_config, data.data.regions || []);
    this.score = data.score;
    this.metadata = data.data.metadata;
    if (data.data.geo && data.data.geo['geo_point']) {
      this.geo = { geoPoint: data.data.geo['geo_point'] };
    }
    this.rawData = data;
    this._config = _config;
  }

  /**
   * Merge concepts to an input
   * @param {object[]}         concepts    Object with keys explained below:
   *   @param {object}           concepts[].concept
   *     @param {string}           concepts[].concept.id        The concept id (required)
   *     @param {boolean}          concepts[].concept.value     Whether or not the input is a positive (true) or negative (false) example of the concept (default: true)
   * @param {object}           metadata                      Object with key values to attach to the input (optional)
   * @return {Promise(Input, error)} A Promise that is fulfilled with an instance of Input or rejected with an error
   */


  _createClass(Input, [{
    key: 'mergeConcepts',
    value: function mergeConcepts(concepts, metadata) {
      return this._update('merge', concepts, metadata);
    }

    /**
     * Delete concept from an input
     * @param {object[]}         concepts    Object with keys explained below:
     *   @param {object}           concepts[].concept
     *     @param {string}           concepts[].concept.id        The concept id (required)
     *     @param {boolean}          concepts[].concept.value     Whether or not the input is a positive (true) or negative (false) example of the concept (default: true)
     * @param {object}           metadata                      Object with key values to attach to the input (optional)
     * @return {Promise(Input, error)} A Promise that is fulfilled with an instance of Input or rejected with an error
     */

  }, {
    key: 'deleteConcepts',
    value: function deleteConcepts(concepts, metadata) {
      return this._update('remove', concepts, metadata);
    }

    /**
     * Overwrite inputs
     * @param {object[]}         concepts                      Array of object with keys explained below:
     *   @param {object}           concepts[].concept
     *     @param {string}           concepts[].concept.id         The concept id (required)
     *     @param {boolean}          concepts[].concept.value      Whether or not the input is a positive (true) or negative (false) example of the concept (default: true)
     * @param {object}           metadata                      Object with key values to attach to the input (optional)
     * @return {Promise(Input, error)} A Promise that is fulfilled with an instance of Input or rejected with an error
     */

  }, {
    key: 'overwriteConcepts',
    value: function overwriteConcepts(concepts, metadata) {
      return this._update('overwrite', concepts, metadata);
    }
  }, {
    key: '_update',
    value: function _update(action) {
      var concepts = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];
      var metadata = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : null;

      var url = '' + this._config.basePath + INPUTS_PATH;
      var inputData = {};
      if (concepts.length) {
        inputData.concepts = concepts;
      }
      if (metadata !== null) {
        inputData.metadata = metadata;
      }
      var data = {
        action: action,
        inputs: [{
          id: this.id,
          data: inputData
        }]
      };
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          return axios.patch(url, data, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Input(response.data.input));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }
  }]);

  return Input;
}();

;

module.exports = Input;
},{"./Concepts":31,"./Regions":38,"./constants":41,"axios":3}],33:[function(require,module,exports){
'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var axios = require('axios');
var Input = require('./Input');

var _require = require('./constants'),
    API = _require.API,
    ERRORS = _require.ERRORS,
    MAX_BATCH_SIZE = _require.MAX_BATCH_SIZE,
    replaceVars = _require.replaceVars;

var INPUT_PATH = API.INPUT_PATH,
    INPUTS_PATH = API.INPUTS_PATH,
    INPUTS_STATUS_PATH = API.INPUTS_STATUS_PATH,
    SEARCH_PATH = API.SEARCH_PATH,
    SEARCH_FEEDBACK_PATH = API.SEARCH_FEEDBACK_PATH;

var _require2 = require('./utils'),
    wrapToken = _require2.wrapToken,
    formatInput = _require2.formatInput,
    formatImagesSearch = _require2.formatImagesSearch,
    formatConceptsSearch = _require2.formatConceptsSearch;

var _require3 = require('./helpers'),
    isSuccess = _require3.isSuccess,
    checkType = _require3.checkType,
    clone = _require3.clone;

/**
 * class representing a collection of inputs
 * @class
 */


var Inputs = function () {
  function Inputs(_config) {
    var _this = this;

    var rawData = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];

    _classCallCheck(this, Inputs);

    this.rawData = rawData;
    rawData.forEach(function (inputData, index) {
      if (inputData.input && inputData.score) {
        inputData.input.score = inputData.score;
        inputData = inputData.input;
      }
      _this[index] = new Input(_this._config, inputData);
    });
    this.length = rawData.length;
    this._config = _config;
  }

  /**
   * Get all inputs in app
   * @param {Object}    options  Object with keys explained below: (optional)
   *   @param {Number}    options.page  The page number (optional, default: 1)
   *   @param {Number}    options.perPage  Number of images to return per page (optional, default: 20)
   * @return {Promise(Inputs, error)} A Promise that is fulfilled with an instance of Inputs or rejected with an error
   */


  _createClass(Inputs, [{
    key: 'list',
    value: function list() {
      var _this2 = this;

      var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : { page: 1, perPage: 20 };

      var url = '' + this._config.basePath + INPUTS_PATH;
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.get(url, {
            headers: headers,
            params: {
              page: options.page,
              per_page: options.perPage
            }
          }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Inputs(_this2._config, response.data.inputs));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }

    /**
     * Adds an input or multiple inputs
     * @param {object|object[]}        inputs                                Can be a single media object or an array of media objects (max of 128 inputs/call; passing > 128 will throw an exception)
     *   @param {object|string}          inputs[].input                        If string, is given, this is assumed to be an image url
     *     @param {string}                 inputs[].input.(url|base64)           Can be a publicly accessibly url or base64 string representing image bytes (required)
     *     @param {string}                 inputs[].input.id                     ID of input (optional)
     *     @param {number[]}               inputs[].input.crop                   An array containing the percent to be cropped from top, left, bottom and right (optional)
     *     @param {boolean}               inputs[].input.allowDuplicateUrl       Whether to allow duplicate URL
     *     @param {object[]}               inputs[].input.metadata               Object with key and values pair (value can be string, array or other objects) to attach to the input (optional)
     *     @param {object}                 inputs[].input.geo                    Object with latitude and longitude coordinates to associate with an input. Can be used in search query as the proximity of an input to a reference point (optional)
     *       @param {number}                 inputs[].input.geo.latitude           +/- latitude val of geodata
     *       @param {number}                 inputs[].input.geo.longitude          +/- longitude val of geodata
     *     @param {object[]}               inputs[].input.concepts               An array of concepts to attach to media object (optional)
     *       @param {object|string}          inputs[].input.concepts[].concept     If string, is given, this is assumed to be concept id with value equals true
     *         @param {string}                 inputs[].input.concepts[].concept.id          The concept id (required)
     *         @param {boolean}                inputs[].input.concepts[].concept.value       Whether or not the input is a positive (true) or negative (false) example of the concept (default: true)
     * @return {Promise(Inputs, error)} A Promise that is fulfilled with an instance of Inputs or rejected with an error
     */

  }, {
    key: 'create',
    value: function create(inputs) {
      var _this3 = this;

      if (checkType(/(String|Object)/, inputs)) {
        inputs = [inputs];
      }
      var url = '' + this._config.basePath + INPUTS_PATH;
      if (inputs.length > MAX_BATCH_SIZE) {
        throw ERRORS.MAX_INPUTS;
      }
      return wrapToken(this._config, function (headers) {
        var data = {
          inputs: inputs.map(formatInput)
        };
        return new Promise(function (resolve, reject) {
          axios.post(url, data, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Inputs(_this3._config, response.data.inputs));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }

    /**
     * Get input by id
     * @param {String}    id  The input id
     * @return {Promise(Input, error)} A Promise that is fulfilled with an instance of Input or rejected with an error
     */

  }, {
    key: 'get',
    value: function get(id) {
      var _this4 = this;

      var url = '' + this._config.basePath + replaceVars(INPUT_PATH, [id]);
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.get(url, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Input(_this4._config, response.data.input));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }

    /**
     * Delete an input or a list of inputs by id or all inputs if no id is passed
     * @param {string|string[]}    id           The id of input to delete (optional)
     * @return {Promise(response, error)} A Promise that is fulfilled with the API response or rejected with an error
     */

  }, {
    key: 'delete',
    value: function _delete() {
      var id = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : null;

      var val = void 0;
      // delete an input
      if (checkType(/String/, id)) {
        var url = '' + this._config.basePath + replaceVars(INPUT_PATH, [id]);
        val = wrapToken(this._config, function (headers) {
          return axios.delete(url, { headers: headers });
        });
      } else {
        val = this._deleteInputs(id);
      }
      return val;
    }
  }, {
    key: '_deleteInputs',
    value: function _deleteInputs() {
      var id = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : null;

      var url = '' + this._config.basePath + INPUTS_PATH;
      return wrapToken(this._config, function (headers) {
        var data = id === null ? { delete_all: true } : { ids: id };
        return axios({
          url: url,
          method: 'delete',
          headers: headers,
          data: data
        });
      });
    }

    /**
     * Merge concepts to inputs in bulk
     * @param {object[]}         inputs    List of concepts to update (max of 128 inputs/call; passing > 128 will throw an exception)
     *   @param {object}           inputs[].input
     *     @param {string}           inputs[].input.id        The id of the input to update
     *     @param {string}           inputs[].input.concepts  Object with keys explained below:
     *       @param {object}           inputs[].input.concepts[].concept
     *         @param {string}           inputs[].input.concepts[].concept.id        The concept id (required)
     *         @param {boolean}          inputs[].input.concepts[].concept.value     Whether or not the input is a positive (true) or negative (false) example of the concept (default: true)
     * @return {Promise(Inputs, error)} A Promise that is fulfilled with an instance of Inputs or rejected with an error
     */

  }, {
    key: 'mergeConcepts',
    value: function mergeConcepts(inputs) {
      inputs.action = 'merge';
      return this.update(inputs);
    }

    /**
     * Delete concepts to inputs in bulk
     * @param {object[]}         inputs    List of concepts to update (max of 128 inputs/call; passing > 128 will throw an exception)
     *   @param {object}           inputs[].input
     *     @param {string}           inputs[].input.id                           The id of the input to update
     *     @param {string}           inputs[].input.concepts                     Object with keys explained below:
     *       @param {object}           inputs[].input.concepts[].concept
     *         @param {string}           inputs[].input.concepts[].concept.id        The concept id (required)
     *         @param {boolean}          inputs[].input.concepts[].concept.value     Whether or not the input is a positive (true) or negative (false) example of the concept (default: true)
     * @return {Promise(Inputs, error)} A Promise that is fulfilled with an instance of Inputs or rejected with an error
     */

  }, {
    key: 'deleteConcepts',
    value: function deleteConcepts(inputs) {
      inputs.action = 'remove';
      return this.update(inputs);
    }

    /**
     * Overwrite inputs in bulk
     * @param {object[]}         inputs    List of concepts to update (max of 128 inputs/call; passing > 128 will throw an exception)
     *   @param {object}           inputs[].input
     *     @param {string}           inputs[].input.id                           The id of the input to update
     *     @param {string}           inputs[].input.concepts                     Object with keys explained below:
     *       @param {object}           inputs[].input.concepts[].concept
     *         @param {string}           inputs[].input.concepts[].concept.id        The concept id (required)
     *         @param {boolean}          inputs[].input.concepts[].concept.value     Whether or not the input is a positive (true) or negative (false) example of the concept (default: true)
     * @return {Promise(Inputs, error)} A Promise that is fulfilled with an instance of Inputs or rejected with an error
     */

  }, {
    key: 'overwriteConcepts',
    value: function overwriteConcepts(inputs) {
      inputs.action = 'overwrite';
      return this.update(inputs);
    }

    /**
     * @param {object[]}         inputs    List of inputs to update (max of 128 inputs/call; passing > 128 will throw an exception)
     *   @param {object}           inputs[].input
     *     @param {string}           inputs[].input.id                           The id of the input to update
     *     @param {object}           inputs[].input.metadata                     Object with key values to attach to the input (optional)
     *     @param {object}           inputs[].input.geo                          Object with latitude and longitude coordinates to associate with an input. Can be used in search query as the proximity of an input to a reference point (optional)
     *       @param {number}           inputs[].input.geo.latitude                 +/- latitude val of geodata
     *       @param {number}           inputs[].input.geo.longitude                +/- longitude val of geodata
     *     @param {string}           inputs[].input.concepts                     Object with keys explained below (optional):
     *       @param {object}           inputs[].input.concepts[].concept
     *         @param {string}           inputs[].input.concepts[].concept.id        The concept id (required)
     *         @param {boolean}          inputs[].input.concepts[].concept.value     Whether or not the input is a positive (true) or negative (false) example of the concept (default: true)
     * @return {Promise(Inputs, error)} A Promise that is fulfilled with an instance of Inputs or rejected with an error
     */

  }, {
    key: 'update',
    value: function update(inputs) {
      var _this5 = this;

      var url = '' + this._config.basePath + INPUTS_PATH;
      var inputsList = Array.isArray(inputs) ? inputs : [inputs];
      if (inputsList.length > MAX_BATCH_SIZE) {
        throw ERRORS.MAX_INPUTS;
      }
      var data = {
        action: inputs.action,
        inputs: inputsList.map(function (input) {
          return formatInput(input, false);
        })
      };
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.patch(url, data, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Inputs(_this5._config, response.data.inputs));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }

    /**
     * Search for inputs or outputs based on concepts or images
     *   @param {object[]}               queries          List of all predictions to match with
     *     @param {object}                 queries[].concept            An object with the following keys:
     *       @param {string}                 queries[].concept.id          The concept id
     *       @param {string}                 queries[].concept.type        Search over 'input' to get input matches to criteria or 'output' to get inputs that are visually similar to the criteria (default: 'output')
     *       @param {string}                 queries[].concept.name        The concept name
     *       @param {boolean}                queries[].concept.value       Indicates whether or not the term should match with the prediction returned (default: true)
     *     @param {object}                 queries[].input              An image object that contains the following keys:
     *       @param {string}                 queries[].input.id            The input id
     *       @param {string}                 queries[].input.type          Search over 'input' to get input matches to criteria or 'output' to get inputs that are visually similar to the criteria (default: 'output')
     *       @param {string}                 queries[].input.(base64|url)  Can be a publicly accessibly url or base64 string representing image bytes (required)
     *       @param {number[]}               queries[].input.crop          An array containing the percent to be cropped from top, left, bottom and right (optional)
     *       @param {object}                 queries[].input.metadata      An object with key and value specified by user to refine search with (optional)
     * @param {Object}                   options       Object with keys explained below: (optional)
     *    @param {Number}                  options.page          The page number (optional, default: 1)
     *    @param {Number}                  options.perPage       Number of images to return per page (optional, default: 20)
     * @return {Promise(response, error)} A Promise that is fulfilled with the API response or rejected with an error
     */

  }, {
    key: 'search',
    value: function search() {
      var queries = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : [];
      var options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : { page: 1, perPage: 20 };

      var formattedAnds = [];
      var url = '' + this._config.basePath + SEARCH_PATH;
      var data = {
        query: {
          ands: []
        },
        pagination: {
          page: options.page,
          per_page: options.perPage
        }
      };

      if (!Array.isArray(queries)) {
        queries = [queries];
      }
      if (queries.length > 0) {
        queries.forEach(function (query) {
          if (query.input) {
            formattedAnds = formattedAnds.concat(formatImagesSearch(query.input));
          } else if (query.concept) {
            formattedAnds = formattedAnds.concat(formatConceptsSearch(query.concept));
          }
        });
        data.query.ands = formattedAnds;
      }
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.post(url, data, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              var _data = clone(response.data);
              _data.rawData = clone(response.data);
              resolve(_data);
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }
  }, {
    key: 'searchFeedback',
    value: function searchFeedback(inputID, searchID, endUserID, sessionID) {
      var url = '' + this._config.basePath + SEARCH_FEEDBACK_PATH;
      var body = {
        input: {
          id: inputID,
          feedback_info: {
            event_type: 'search_click',
            search_id: searchID,
            end_user_id: endUserID,
            session_id: sessionID
          }
        }
      };
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.post(url, body, {
            headers: headers
          }).then(function (_ref) {
            var data = _ref.data;

            var d = clone(data);
            d.rawData = clone(data);
            resolve(d);
          }, reject);
        });
      });
    }

    /**
     * Get inputs status (number of uploaded, in process or failed inputs)
     * @return {Promise(response, error)} A Promise that is fulfilled with the API response or rejected with an error
     */

  }, {
    key: 'getStatus',
    value: function getStatus() {
      var url = '' + this._config.basePath + INPUTS_STATUS_PATH;
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.get(url, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              var data = clone(response.data);
              data.rawData = clone(response.data);
              resolve(data);
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }
  }]);

  return Inputs;
}();

;

module.exports = Inputs;
},{"./Input":32,"./constants":41,"./helpers":42,"./utils":46,"axios":3}],34:[function(require,module,exports){
'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var axios = require('axios');
var ModelVersion = require('./ModelVersion');

var _require = require('./helpers'),
    isSuccess = _require.isSuccess,
    checkType = _require.checkType,
    clone = _require.clone;

var _require2 = require('./constants'),
    API = _require2.API,
    SYNC_TIMEOUT = _require2.SYNC_TIMEOUT,
    replaceVars = _require2.replaceVars,
    STATUS = _require2.STATUS,
    POLLTIME = _require2.POLLTIME;

var MODEL_QUEUED_FOR_TRAINING = STATUS.MODEL_QUEUED_FOR_TRAINING,
    MODEL_TRAINING = STATUS.MODEL_TRAINING;

var _require3 = require('./utils'),
    wrapToken = _require3.wrapToken,
    formatMediaPredict = _require3.formatMediaPredict,
    formatModel = _require3.formatModel,
    formatObjectForSnakeCase = _require3.formatObjectForSnakeCase;

var MODEL_VERSIONS_PATH = API.MODEL_VERSIONS_PATH,
    MODEL_VERSION_PATH = API.MODEL_VERSION_PATH,
    MODELS_PATH = API.MODELS_PATH,
    MODEL_FEEDBACK_PATH = API.MODEL_FEEDBACK_PATH,
    MODEL_VERSION_FEEDBACK_PATH = API.MODEL_VERSION_FEEDBACK_PATH,
    PREDICT_PATH = API.PREDICT_PATH,
    VERSION_PREDICT_PATH = API.VERSION_PREDICT_PATH,
    MODEL_INPUTS_PATH = API.MODEL_INPUTS_PATH,
    MODEL_VERSION_OUTPUT_PATH = API.MODEL_VERSION_OUTPUT_PATH,
    MODEL_OUTPUT_PATH = API.MODEL_OUTPUT_PATH,
    MODEL_VERSION_INPUTS_PATH = API.MODEL_VERSION_INPUTS_PATH,
    MODEL_VERSION_METRICS_PATH = API.MODEL_VERSION_METRICS_PATH;

/**
 * class representing a model
 * @class
 */

var Model = function () {
  function Model(_config, data) {
    _classCallCheck(this, Model);

    this._config = _config;
    this.name = data.name;
    this.id = data.id;
    this.createdAt = data.created_at || data.createdAt;
    this.appId = data.app_id || data.appId;
    this.outputInfo = data.output_info || data.outputInfo;
    if (checkType(/(String)/, data.version)) {
      this.modelVersion = {};
      this.versionId = data.version;
    } else {
      if (data.model_version || data.modelVersion || data.version) {
        this.modelVersion = new ModelVersion(this._config, data.model_version || data.modelVersion || data.version);
      }
      this.versionId = (this.modelVersion || {}).id;
    }
    this.rawData = data;
  }

  /**
   * Merge concepts to a model
   * @param {object[]}      concepts    List of concept objects with id
   * @return {Promise(Model, error)} A Promise that is fulfilled with a Model instance or rejected with an error
   */


  _createClass(Model, [{
    key: 'mergeConcepts',
    value: function mergeConcepts() {
      var concepts = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : [];

      var conceptsArr = Array.isArray(concepts) ? concepts : [concepts];
      return this.update({ action: 'merge', concepts: conceptsArr });
    }

    /**
     * Remove concepts from a model
     * @param {object[]}      concepts    List of concept objects with id
     * @return {Promise(Model, error)} A Promise that is fulfilled with a Model instance or rejected with an error
     */

  }, {
    key: 'deleteConcepts',
    value: function deleteConcepts() {
      var concepts = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : [];

      var conceptsArr = Array.isArray(concepts) ? concepts : [concepts];
      return this.update({ action: 'remove', concepts: conceptsArr });
    }

    /**
     * Overwrite concepts in a model
     * @param {object[]}      concepts    List of concept objects with id
     * @return {Promise(Model, error)} A Promise that is fulfilled with a Model instance or rejected with an error
     */

  }, {
    key: 'overwriteConcepts',
    value: function overwriteConcepts() {
      var concepts = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : [];

      var conceptsArr = Array.isArray(concepts) ? concepts : [concepts];
      return this.update({ action: 'overwrite', concepts: conceptsArr });
    }

    /**
     * Start a model evaluation job
     * @return {Promise(ModelVersion, error)} A Promise that is fulfilled with a ModelVersion instance or rejected with an error
     */

  }, {
    key: 'runModelEval',
    value: function runModelEval() {
      var _this = this;

      var url = '' + this._config.basePath + replaceVars(MODEL_VERSION_METRICS_PATH, [this.id, this.versionId]);
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.post(url, {}, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new ModelVersion(_this._config, response.data.model_version));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }

    /**
     * Update a model's output config or concepts
     * @param {object}               model                                 An object with any of the following attrs:
     *   @param {string}               name                                  The new name of the model to update with
     *   @param {boolean}              conceptsMutuallyExclusive             Do you expect to see more than one of the concepts in this model in the SAME image? Set to false (default) if so. Otherwise, set to true.
     *   @param {boolean}              closedEnvironment                     Do you expect to run the trained model on images that do not contain ANY of the concepts in the model? Set to false (default) if so. Otherwise, set to true.
     *   @param {object[]}             concepts                              An array of concept objects or string
     *     @param {object|string}        concepts[].concept                    If string is given, this is interpreted as concept id. Otherwise, if object is given, client expects the following attributes
     *       @param {string}             concepts[].concept.id                   The id of the concept to attach to the model
     *   @param {object[]}             action                                The action to perform on the given concepts. Possible values are 'merge', 'remove', or 'overwrite'. Default: 'merge'
     * @return {Promise(Model, error)} A Promise that is fulfilled with a Model instance or rejected with an error
     */

  }, {
    key: 'update',
    value: function update(obj) {
      var _this2 = this;

      var url = '' + this._config.basePath + MODELS_PATH;
      var modelData = [obj];
      var data = { models: modelData.map(function (m) {
          return formatModel(Object.assign(m, { id: _this2.id }));
        }) };
      if (Array.isArray(obj.concepts)) {
        data['action'] = obj.action || 'merge';
      }

      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.patch(url, data, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Model(_this2._config, response.data.models[0]));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }

    /**
     * Create a new model version
     * @param {boolean}       sync     If true, this returns after model has completely trained. If false, this immediately returns default api response.
     * @return {Promise(Model, error)} A Promise that is fulfilled with a Model instance or rejected with an error
     */

  }, {
    key: 'train',
    value: function train(sync) {
      var _this3 = this;

      var url = '' + this._config.basePath + replaceVars(MODEL_VERSIONS_PATH, [this.id]);
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.post(url, null, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              // Training produces a new model version ID.
              _this3.versionId = response.data.model.model_version.id;

              if (sync) {
                var timeStart = Date.now();
                _this3._pollTrain.bind(_this3)(timeStart, resolve, reject);
              } else {
                resolve(new Model(_this3._config, response.data.model));
              }
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }
  }, {
    key: '_pollTrain',
    value: function _pollTrain(timeStart, resolve, reject) {
      var _this4 = this;

      clearTimeout(this.pollTimeout);
      if (Date.now() - timeStart >= SYNC_TIMEOUT) {
        return reject({
          status: 'Error',
          message: 'Sync call timed out'
        });
      }
      this.getOutputInfo().then(function (model) {
        var modelStatusCode = model.modelVersion.status.code.toString();
        if (modelStatusCode === MODEL_QUEUED_FOR_TRAINING || modelStatusCode === MODEL_TRAINING) {
          _this4.pollTimeout = setTimeout(function () {
            return _this4._pollTrain(timeStart, resolve, reject);
          }, POLLTIME);
        } else {
          resolve(model);
        }
      }, reject).catch(reject);
    }

    /**
     * Returns model ouputs according to inputs
     * @param {object[]|object|string}       inputs    An array of objects/object/string pointing to an image resource. A string can either be a url or base64 image bytes. Object keys explained below:
     *    @param {object}                      inputs[].image     Object with keys explained below:
     *       @param {string}                     inputs[].image.(url|base64)   Can be a publicly accessibly url or base64 string representing image bytes (required)
     *       @param {number[]}                   inputs[].image.crop           An array containing the percent to be cropped from top, left, bottom and right (optional)
     * @param {object|string} config An object with keys explained below. If a string is passed instead, it will be treated as the language (backwards compatibility)
     *   @param {string} config.language A string code representing the language to return results in (example: 'zh' for simplified Chinese, 'ru' for Russian, 'ja' for Japanese)
     *   @param {boolean} config.video indicates if the input should be processed as a video
     *   @param {object[]} config.selectConcepts An array of concepts to return. Each object in the array will have a form of {name: <CONCEPT_NAME>} or {id: CONCEPT_ID}
     *   @param {float} config.minValue The minimum confidence threshold that a result must meet. From 0.0 to 1.0
     *   @param {number} config.maxConcepts The maximum number of concepts to return
     * @param {boolean} isVideo  Deprecated: indicates if the input should be processed as a video (default false). Deprecated in favor of using config object
     * @return {Promise(response, error)} A Promise that is fulfilled with the API response or rejected with an error
     */

  }, {
    key: 'predict',
    value: function predict(inputs) {
      var config = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
      var isVideo = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : false;

      if (checkType(/String/, config)) {
        console.warn('passing the language as a string is deprecated, consider using the configuration object instead');
        config = {
          language: config
        };
      }

      if (isVideo) {
        console.warn('"isVideo" argument is deprecated, consider using the configuration object instead');
        config.video = isVideo;
      }
      var video = config.video || false;
      delete config.video;
      if (checkType(/(Object|String)/, inputs)) {
        inputs = [inputs];
      }
      var url = '' + this._config.basePath + (this.versionId ? replaceVars(VERSION_PREDICT_PATH, [this.id, this.versionId]) : replaceVars(PREDICT_PATH, [this.id]));
      return wrapToken(this._config, function (headers) {
        var params = { inputs: inputs.map(function (input) {
            return formatMediaPredict(input, video ? 'video' : 'image');
          }) };
        if (config && Object.getOwnPropertyNames(config).length > 0) {
          params['model'] = {
            output_info: {
              output_config: formatObjectForSnakeCase(config)
            }
          };
        }
        return new Promise(function (resolve, reject) {
          axios.post(url, params, { headers: headers }).then(function (response) {
            var data = clone(response.data);
            data.rawData = clone(response.data);
            resolve(data);
          }, reject);
        });
      });
    }

    /**
     * Returns a version of the model specified by its id
     * @param {string}     versionId   The model's id
     * @return {Promise(response, error)} A Promise that is fulfilled with the API response or rejected with an error
     */

  }, {
    key: 'getVersion',
    value: function getVersion(versionId) {
      // TODO(Rok) MEDIUM: The version ID isn't URI encoded, as opposed to the model ID. This should probably be
      //  consistent - i.e. the same in both cases.
      var url = '' + this._config.basePath + replaceVars(MODEL_VERSION_PATH, [this.id, versionId]);
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.get(url, { headers: headers }).then(function (response) {
            var data = clone(response.data);
            data.rawData = clone(response.data);
            resolve(data);
          }, reject);
        });
      });
    }

    /**
     * Returns a list of versions of the model
     * @param {object}     options     Object with keys explained below: (optional)
     *   @param {number}     options.page        The page number (optional, default: 1)
     *   @param {number}     options.perPage     Number of images to return per page (optional, default: 20)
     * @return {Promise(response, error)} A Promise that is fulfilled with the API response or rejected with an error
     */

  }, {
    key: 'getVersions',
    value: function getVersions() {
      var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : { page: 1, perPage: 20 };

      var url = '' + this._config.basePath + replaceVars(MODEL_VERSIONS_PATH, [this.id]);
      return wrapToken(this._config, function (headers) {
        var data = {
          headers: headers,
          params: { 'per_page': options.perPage, 'page': options.page }
        };
        return new Promise(function (resolve, reject) {
          axios.get(url, data).then(function (response) {
            var data = clone(response.data);
            data.rawData = clone(response.data);
            resolve(data);
          }, reject);
        });
      });
    }

    /**
     * Returns all the model's output info
     * @return {Promise(Model, error)} A Promise that is fulfilled with a Model instance or rejected with an error
     */

  }, {
    key: 'getOutputInfo',
    value: function getOutputInfo() {
      var _this5 = this;

      var url = '' + this._config.basePath + (this.versionId ? replaceVars(MODEL_VERSION_OUTPUT_PATH, [this.id, this.versionId]) : replaceVars(MODEL_OUTPUT_PATH, [this.id]));
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.get(url, { headers: headers }).then(function (response) {
            resolve(new Model(_this5._config, response.data.model));
          }, reject);
        });
      });
    }

    /**
     * Returns all the model's inputs
     * @param {object}     options     Object with keys explained below: (optional)
     *   @param {number}     options.page        The page number (optional, default: 1)
     *   @param {number}     options.perPage     Number of images to return per page (optional, default: 20)
     * @return {Promise(response, error)} A Promise that is fulfilled with the API response or rejected with an error
     */

  }, {
    key: 'getInputs',
    value: function getInputs() {
      var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : { page: 1, perPage: 20 };

      var url = '' + this._config.basePath + (this.versionId ? replaceVars(MODEL_VERSION_INPUTS_PATH, [this.id, this.versionId]) : replaceVars(MODEL_INPUTS_PATH, [this.id]));
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.get(url, {
            params: { 'per_page': options.perPage, 'page': options.page },
            headers: headers
          }).then(function (response) {
            var data = clone(response.data);
            data.rawData = clone(response.data);
            resolve(data);
          }, reject);
        });
      });
    }

    /**
     *
     * @param {string} input A string pointing to an image resource. A string must be a url
     * @param {object} config A configuration object consisting of the following required keys
     *   @param {string} config.id The id of the feedback request
     *   @param {object} config.data The feedback data to be sent
     *   @param {object} config.info Meta data related to the feedback request
     * @return {Promise(response, error)} A Promise that is fulfilled with the API response or rejected with an error
     */

  }, {
    key: 'feedback',
    value: function feedback(input, _ref) {
      var id = _ref.id,
          data = _ref.data,
          info = _ref.info;

      var url = '' + this._config.basePath + (this.versionId ? replaceVars(MODEL_VERSION_FEEDBACK_PATH, [this.id, this.versionId]) : replaceVars(MODEL_FEEDBACK_PATH, [this.id]));
      var media = formatMediaPredict(input).data;
      info.eventType = 'annotation';
      var body = {
        input: {
          id: id,
          data: Object.assign(media, data),
          'feedback_info': formatObjectForSnakeCase(info)
        }
      };
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.post(url, body, {
            headers: headers
          }).then(function (_ref2) {
            var data = _ref2.data;

            var d = clone(data);
            d.rawData = clone(data);
            resolve(d);
          }, reject);
        });
      });
    }
  }]);

  return Model;
}();

module.exports = Model;
},{"./ModelVersion":35,"./constants":41,"./helpers":42,"./utils":46,"axios":3}],35:[function(require,module,exports){
"use strict";

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

/**
 * class representing a version of a model
 * @class
 */
var ModelVersion = function ModelVersion(_config, data) {
  _classCallCheck(this, ModelVersion);

  this.id = data.id;
  this.created_at = this.createdAt = data.created_at || data.createdAt;
  this.status = data.status;
  this.active_concept_count = data.active_concept_count;
  this.metrics = data.metrics;
  this._config = _config;
  this.rawData = data;
};

;

module.exports = ModelVersion;
},{}],36:[function(require,module,exports){
'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var axios = require('axios');
var Promise = require('promise');
var Model = require('./Model');
var Concepts = require('./Concepts');

var _require = require('./constants'),
    API = _require.API,
    ERRORS = _require.ERRORS,
    replaceVars = _require.replaceVars;

var _require2 = require('./helpers'),
    isSuccess = _require2.isSuccess,
    checkType = _require2.checkType,
    clone = _require2.clone;

var _require3 = require('./utils'),
    wrapToken = _require3.wrapToken,
    formatModel = _require3.formatModel;

var MODELS_PATH = API.MODELS_PATH,
    MODEL_PATH = API.MODEL_PATH,
    MODEL_SEARCH_PATH = API.MODEL_SEARCH_PATH,
    MODEL_VERSION_PATH = API.MODEL_VERSION_PATH;

/**
 * class representing a collection of models
 * @class
 */

var Models = function () {
  function Models(_config) {
    var _this = this;

    var rawData = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];

    _classCallCheck(this, Models);

    this._config = _config;
    this.rawData = rawData;
    rawData.forEach(function (modelData, index) {
      _this[index] = new Model(_this._config, modelData);
    });
    this.length = rawData.length;
  }

  /**
   * Returns a Model instance given model id or name. It will call search if name is given.
   * @param {string|object}    model       If string, it is assumed to be model id. Otherwise, if object is given, it can have any of the following keys:
   *   @param {string}           model.id          Model id
   *   @param {string}           model.name        Model name
   *   @param {string}           model.version     Model version
   *   @param {string}           model.type        This can be "concept", "color", "embed", "facedetect", "cluster" or "blur"
   * @return {Promise(Model, error)} A Promise that is fulfilled with a Model instance or rejected with an error
   */


  _createClass(Models, [{
    key: 'initModel',
    value: function initModel(model) {
      var _this2 = this;

      var data = {};
      var fn = void 0;
      if (checkType(/String/, model)) {
        data.id = model;
      } else {
        data = model;
      }
      if (data.id) {
        fn = function fn(resolve, reject) {
          resolve(new Model(_this2._config, data));
        };
      } else {
        fn = function fn(resolve, reject) {
          _this2.search(data.name, data.type).then(function (models) {
            if (data.version) {
              resolve(models.rawData.filter(function (model) {
                return model.modelVersion.id === data.version;
              }));
            } else {
              resolve(models[0]);
            }
          }, reject).catch(reject);
        };
      }
      return new Promise(fn);
    }

    /**
     * Calls predict given model info and inputs to predict on
     * @param {string|object}            model       If string, it is assumed to be model id. Otherwise, if object is given, it can have any of the following keys:
     *   @param {string}                   model.id          Model id
     *   @param {string}                   model.name        Model name
     *   @param {string}                   model.version     Model version
     *   @param {string}                   model.language    Model language (only for Clarifai's public models)
     *   @param {string}                   model.type        This can be "concept", "color", "embed", "facedetect", "cluster" or "blur"
     * @param {object[]|object|string}   inputs    An array of objects/object/string pointing to an image resource. A string can either be a url or base64 image bytes. Object keys explained below:
     *    @param {object}                  inputs[].image     Object with keys explained below:
     *       @param {string}                 inputs[].image.(url|base64)  Can be a publicly accessibly url or base64 string representing image bytes (required)
     * @param {boolean} isVideo  indicates if the input should be processed as a video (default false)
     * @return {Promise(response, error)} A Promise that is fulfilled with the API response or rejected with an error
     */

  }, {
    key: 'predict',
    value: function predict(model, inputs) {
      var _this3 = this;

      var config = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};

      if (checkType(/Boolean/, config)) {
        console.warn('"isVideo" argument is deprecated, consider using the configuration object instead');
        config = {
          video: config
        };
      }
      if (model.language) {
        config.language = model.language;
      }
      return new Promise(function (resolve, reject) {
        _this3.initModel(model).then(function (modelObj) {
          modelObj.predict(inputs, config).then(resolve, reject).catch(reject);
        }, reject);
      });
    }

    /**
     * Calls train on a model and creates a new model version given model info
     * @param {string|object}            model       If string, it is assumed to be model id. Otherwise, if object is given, it can have any of the following keys:
     *   @param {string}                   model.id          Model id
     *   @param {string}                   model.name        Model name
     *   @param {string}                   model.version     Model version
     *   @param {string}                   model.type        This can be "concept", "color", "embed", "facedetect", "cluster" or "blur"
     * @param {boolean}                  sync        If true, this returns after model has completely trained. If false, this immediately returns default api response.
     * @return {Promise(Model, error)} A Promise that is fulfilled with a Model instance or rejected with an error
     */

  }, {
    key: 'train',
    value: function train(model) {
      var _this4 = this;

      var sync = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : false;

      return new Promise(function (resolve, reject) {
        _this4.initModel(model).then(function (model) {
          model.train(sync).then(resolve, reject).catch(reject);
        }, reject);
      });
    }

    /**
     *
     * @param {string|object}            model       If string, it is assumed to be model id. Otherwise, if object is given, it can have any of the following keys:
     *   @param {string}                   model.id          Model id
     *   @param {string}                   model.name        Model name
     *   @param {string}                   model.version     Model version
     *   @param {string}                   model.type        This can be "concept", "color", "embed", "facedetect", "cluster" or "blur"
     * @param {string} input A string pointing to an image resource. A string must be a url
     * @param {object} config A configuration object consisting of the following required keys
     *   @param {string} config.id The id of the feedback request
     *   @param {object} config.data The feedback data to be sent
     *   @param {object} config.info Meta data related to the feedback request
     */

  }, {
    key: 'feedback',
    value: function feedback(model, input, config) {
      var _this5 = this;

      return new Promise(function (resolve, reject) {
        _this5.initModel(model).then(function (model) {
          return model.feedback(input, config);
        }).then(function (d) {
          return resolve(d);
        }).catch(function (e) {
          return reject(e);
        });
      });
    }

    /**
     * Returns a version of the model specified by its id
     * @param {string|object}            model       If string, it is assumed to be model id. Otherwise, if object is given, it can have any of the following keys:
     *   @param {string}                   model.id          Model id
     *   @param {string}                   model.name        Model name
     *   @param {string}                   model.version     Model version
     *   @param {string}                   model.type        This can be "concept", "color", "embed", "facedetect", "cluster" or "blur"
     * @param {string}     versionId   The model's id
     * @return {Promise(response, error)} A Promise that is fulfilled with the API response or rejected with an error
     */

  }, {
    key: 'getVersion',
    value: function getVersion(model, versionId) {
      var _this6 = this;

      return new Promise(function (resolve, reject) {
        _this6.initModel(model).then(function (model) {
          model.getVersion(versionId).then(resolve, reject).catch(reject);
        }, reject);
      });
    }

    /**
     * Returns a list of versions of the model
     * @param {string|object}            model       If string, it is assumed to be model id. Otherwise, if object is given, it can have any of the following keys:
     *   @param {string}                   model.id          Model id
     *   @param {string}                   model.name        Model name
     *   @param {string}                   model.version     Model version
     *   @param {string}                   model.type        This can be "concept", "color", "embed", "facedetect", "cluster" or "blur"
     * @param {object}                   options     Object with keys explained below: (optional)
     *   @param {number}                   options.page        The page number (optional, default: 1)
     *   @param {number}                   options.perPage     Number of images to return per page (optional, default: 20)
     * @return {Promise(response, error)} A Promise that is fulfilled with the API response or rejected with an error
     */

  }, {
    key: 'getVersions',
    value: function getVersions(model) {
      var _this7 = this;

      var options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : { page: 1, perPage: 20 };

      return new Promise(function (resolve, reject) {
        _this7.initModel(model).then(function (model) {
          model.getVersions(options).then(resolve, reject).catch(reject);
        }, reject);
      });
    }

    /**
     * Returns all the model's output info
     * @param {string|object}            model       If string, it is assumed to be model id. Otherwise, if object is given, it can have any of the following keys:
     *   @param {string}                   model.id          Model id
     *   @param {string}                   model.name        Model name
     *   @param {string}                   model.version     Model version
     *   @param {string}                   model.type        This can be "concept", "color", "embed", "facedetect", "cluster" or "blur"
     * @return {Promise(Model, error)} A Promise that is fulfilled with a Model instance or rejected with an error
     */

  }, {
    key: 'getOutputInfo',
    value: function getOutputInfo(model) {
      var _this8 = this;

      return new Promise(function (resolve, reject) {
        _this8.initModel(model).then(function (model) {
          model.getOutputInfo().then(resolve, reject).catch(reject);
        }, reject);
      });
    }

    /**
     * Returns all the models
     * @param {Object}     options     Object with keys explained below: (optional)
     *   @param {Number}     options.page        The page number (optional, default: 1)
     *   @param {Number}     options.perPage     Number of images to return per page (optional, default: 20)
     * @return {Promise(Models, error)} A Promise that is fulfilled with an instance of Models or rejected with an error
     */

  }, {
    key: 'list',
    value: function list() {
      var _this9 = this;

      var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : { page: 1, perPage: 20 };

      var url = '' + this._config.basePath + MODELS_PATH;
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.get(url, {
            params: { 'per_page': options.perPage, 'page': options.page },
            headers: headers
          }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Models(_this9._config, response.data.models));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }

    /**
     * Create a model
     * @param {string|object}                  model                                  If string, it is assumed to be the model id. Otherwise, if object is given, it can have any of the following keys:
     *   @param {string}                         model.id                               Model id
     *   @param {string}                         model.name                             Model name
     * @param {object[]|string[]|Concepts[]}   conceptsData                           List of objects with ids, concept id strings or an instance of Concepts object
     * @param {Object}                         options                                Object with keys explained below:
     *   @param {boolean}                        options.conceptsMutuallyExclusive      Do you expect to see more than one of the concepts in this model in the SAME image? Set to false (default) if so. Otherwise, set to true.
     *   @param {boolean}                        options.closedEnvironment              Do you expect to run the trained model on images that do not contain ANY of the concepts in the model? Set to false (default) if so. Otherwise, set to true.
     * @return {Promise(Model, error)} A Promise that is fulfilled with an instance of Model or rejected with an error
     */

  }, {
    key: 'create',
    value: function create(model) {
      var _this10 = this;

      var conceptsData = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];
      var options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};

      var concepts = conceptsData instanceof Concepts ? conceptsData.toObject('id') : conceptsData.map(function (concept) {
        var val = concept;
        if (checkType(/String/, concept)) {
          val = { 'id': concept };
        }
        return val;
      });
      var modelObj = model;
      if (checkType(/String/, model)) {
        modelObj = { id: model, name: model };
      }
      if (modelObj.id === undefined) {
        throw ERRORS.paramsRequired('Model ID');
      }
      var url = '' + this._config.basePath + MODELS_PATH;
      var data = { model: modelObj };
      data['model']['output_info'] = {
        'data': {
          concepts: concepts
        },
        'output_config': {
          'concepts_mutually_exclusive': !!options.conceptsMutuallyExclusive,
          'closed_environment': !!options.closedEnvironment
        }
      };

      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.post(url, data, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Model(_this10._config, response.data.model));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }

    /**
     * Returns a model specified by ID
     * @param {String}     id          The model's id
     * @return {Promise(Model, error)} A Promise that is fulfilled with an instance of Model or rejected with an error
     */

  }, {
    key: 'get',
    value: function get(id) {
      var _this11 = this;

      var url = '' + this._config.basePath + replaceVars(MODEL_PATH, [id]);
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.get(url, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Model(_this11._config, response.data.model));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }

    /**
     * Update a model's or a list of models' output config or concepts
     * @param {object|object[]}      models                                 Can be a single model object or list of model objects with the following attrs:
     *   @param {string}               models.id                                    The id of the model to apply changes to (Required)
     *   @param {string}               models.name                                  The new name of the model to update with
     *   @param {boolean}              models.conceptsMutuallyExclusive             Do you expect to see more than one of the concepts in this model in the SAME image? Set to false (default) if so. Otherwise, set to true.
     *   @param {boolean}              models.closedEnvironment                     Do you expect to run the trained model on images that do not contain ANY of the concepts in the model? Set to false (default) if so. Otherwise, set to true.
     *   @param {object[]}             models.concepts                              An array of concept objects or string
     *     @param {object|string}        models.concepts[].concept                    If string is given, this is interpreted as concept id. Otherwise, if object is given, client expects the following attributes
     *       @param {string}             models.concepts[].concept.id                   The id of the concept to attach to the model
     *   @param {object[]}             models.action                                The action to perform on the given concepts. Possible values are 'merge', 'remove', or 'overwrite'. Default: 'merge'
     * @return {Promise(Models, error)} A Promise that is fulfilled with an instance of Models or rejected with an error
     */

  }, {
    key: 'update',
    value: function update(models) {
      var _this12 = this;

      var url = '' + this._config.basePath + MODELS_PATH;
      var modelsList = Array.isArray(models) ? models : [models];
      var data = { models: modelsList.map(formatModel) };
      data['action'] = models.action || 'merge';
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.patch(url, data, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Models(_this12._config, response.data.models));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }

    /**
     * Update model by merging concepts
     * @param {object|object[]}      model                                 Can be a single model object or list of model objects with the following attrs:
     *   @param {string}               model.id                                    The id of the model to apply changes to (Required)
     *   @param {object[]}             model.concepts                              An array of concept objects or string
     *     @param {object|string}        model.concepts[].concept                    If string is given, this is interpreted as concept id. Otherwise, if object is given, client expects the following attributes
     *       @param {string}             model.concepts[].concept.id                   The id of the concept to attach to the model
     */

  }, {
    key: 'mergeConcepts',
    value: function mergeConcepts() {
      var model = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

      model.action = 'merge';
      return this.update(model);
    }

    /**
     * Update model by removing concepts
     * @param {object|object[]}      model                                 Can be a single model object or list of model objects with the following attrs:
     *   @param {string}               model.id                                    The id of the model to apply changes to (Required)
     *   @param {object[]}             model.concepts                              An array of concept objects or string
     *     @param {object|string}        model.concepts[].concept                    If string is given, this is interpreted as concept id. Otherwise, if object is given, client expects the following attributes
     *       @param {string}             model.concepts[].concept.id                   The id of the concept to attach to the model
     */

  }, {
    key: 'deleteConcepts',
    value: function deleteConcepts() {
      var model = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

      model.action = 'remove';
      return this.update(model);
    }

    /**
     * Update model by overwriting concepts
     * @param {object|object[]}      model                                 Can be a single model object or list of model objects with the following attrs:
     *   @param {string}               model.id                                    The id of the model to apply changes to (Required)
     *   @param {object[]}             model.concepts                              An array of concept objects or string
     *     @param {object|string}        model.concepts[].concept                    If string is given, this is interpreted as concept id. Otherwise, if object is given, client expects the following attributes
     *       @param {string}             model.concepts[].concept.id                   The id of the concept to attach to the model
     */

  }, {
    key: 'overwriteConcepts',
    value: function overwriteConcepts() {
      var model = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

      model.action = 'overwrite';
      return this.update(model);
    }

    /**
     * Deletes all models (if no ids and versionId given) or a model (if given id) or a model version (if given id and verion id)
     * @param {String|String[]}      ids         Can be a single string or an array of strings representing the model ids
     * @param {String}               versionId   The model's version id
     * @return {Promise(response, error)} A Promise that is fulfilled with the API response or rejected with an error
     */

  }, {
    key: 'delete',
    value: function _delete(ids) {
      var versionId = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;

      var request = void 0,
          url = void 0,
          data = void 0;
      var id = ids;

      if (checkType(/String/, ids) || checkType(/Array/, ids) && ids.length === 1) {
        if (versionId) {
          url = '' + this._config.basePath + replaceVars(MODEL_VERSION_PATH, [id, versionId]);
        } else {
          url = '' + this._config.basePath + replaceVars(MODEL_PATH, [id]);
        }
        request = wrapToken(this._config, function (headers) {
          return new Promise(function (resolve, reject) {
            axios.delete(url, { headers: headers }).then(function (response) {
              var data = clone(response.data);
              data.rawData = clone(response.data);
              resolve(data);
            }, reject);
          });
        });
      } else {
        if (!ids && !versionId) {
          url = '' + this._config.basePath + MODELS_PATH;
          data = { 'delete_all': true };
        } else if (!versionId && ids.length > 1) {
          url = '' + this._config.basePath + MODELS_PATH;
          data = { ids: ids };
        } else {
          throw ERRORS.INVALID_DELETE_ARGS;
        }
        request = wrapToken(this._config, function (headers) {
          return new Promise(function (resolve, reject) {
            axios({
              method: 'delete',
              url: url,
              data: data,
              headers: headers
            }).then(function (response) {
              var data = clone(response.data);
              data.rawData = clone(response.data);
              resolve(data);
            }, reject);
          });
        });
      }

      return request;
    }

    /**
     * Search for models by name or type
     * @param {String}     name        The model name
     * @param {String}     type        This can be "concept", "color", "embed", "facedetect", "cluster" or "blur"
     * @return {Promise(models, error)} A Promise that is fulfilled with an instance of Models or rejected with an error
     */

  }, {
    key: 'search',
    value: function search(name) {
      var _this13 = this;

      var type = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;

      var url = '' + this._config.basePath + MODEL_SEARCH_PATH;
      return wrapToken(this._config, function (headers) {
        var params = {
          'model_query': {
            name: name,
            type: type
          }
        };
        return new Promise(function (resolve, reject) {
          axios.post(url, params, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Models(_this13._config, response.data.models));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }
  }]);

  return Models;
}();

module.exports = Models;
},{"./Concepts":31,"./Model":34,"./constants":41,"./helpers":42,"./utils":46,"axios":3,"promise":49}],37:[function(require,module,exports){
"use strict";

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

/**
 * Region / bounding box. Region points are percentages from the edge.
 * E.g. top of 0.2 means the cropped input will start 20% down from the original edge.
 * @class
 */
var Region = function Region(_config, data) {
  _classCallCheck(this, Region);

  this.id = data.id;
  this.top = data.region_info.bounding_box.top_row;
  this.left = data.region_info.bounding_box.left_col;
  this.bottom = data.region_info.bounding_box.bottom_row;
  this.right = data.region_info.bounding_box.right_col;
};

module.exports = Region;
},{}],38:[function(require,module,exports){
'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var Region = require('./Region');

/**
 * A collection of regions.
 * @class
 */

var Regions = function () {
  function Regions(_config) {
    var _this = this;

    var rawData = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];

    _classCallCheck(this, Regions);

    this._config = _config;
    this.rawData = rawData;
    rawData.forEach(function (regionData, index) {
      _this[index] = new Region(_this._config, regionData);
    });
    this.length = rawData.length;
  }

  _createClass(Regions, [{
    key: Symbol.iterator,
    value: function value() {
      var _this2 = this;

      var index = -1;
      return {
        next: function next() {
          return { value: _this2[++index], done: index >= _this2.length };
        }
      };
    }
  }]);

  return Regions;
}();

module.exports = Regions;
},{"./Region":37}],39:[function(require,module,exports){
'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

var _utils = require('./utils');

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var axios = require('axios');

var _require = require('./constants'),
    API = _require.API,
    replaceVars = _require.replaceVars;

var WORKFLOWS_PATH = API.WORKFLOWS_PATH,
    WORKFLOW_PATH = API.WORKFLOW_PATH,
    WORKFLOW_RESULTS_PATH = API.WORKFLOW_RESULTS_PATH;

var _require2 = require('./utils'),
    wrapToken = _require2.wrapToken,
    formatInput = _require2.formatInput;

var _require3 = require('./helpers'),
    checkType = _require3.checkType;

/**
 * class representing a workflow
 * @class
 */


var Workflow = function () {
  function Workflow(_config) {
    var rawData = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];

    _classCallCheck(this, Workflow);

    this._config = _config;
    this.rawData = rawData;
    this.id = rawData.id;
    this.createdAt = rawData.created_at || rawData.createdAt;
    this.appId = rawData.app_id || rawData.appId;
  }

  /**
   * @deprecated
   */


  _createClass(Workflow, [{
    key: 'create',
    value: function create(workflowId, config) {
      var url = '' + this._config.basePath + WORKFLOWS_PATH;
      var modelId = config.modelId;
      var modelVersionId = config.modelVersionId;
      var body = {
        workflows: [{
          id: workflowId,
          nodes: [{
            id: 'concepts',
            model: {
              id: modelId,
              model_version: {
                id: modelVersionId
              }
            }
          }]
        }]
      };

      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.post(url, body, {
            headers: headers
          }).then(function (response) {
            var workflowId = response.data.workflows[0].id;
            resolve(workflowId);
          }, reject);
        });
      });
    }

    /**
     * @deprecated
     */

  }, {
    key: 'delete',
    value: function _delete(workflowId, config) {
      var url = '' + this._config.basePath + replaceVars(WORKFLOW_PATH, [workflowId]);
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.delete(url, {
            headers: headers
          }).then(function (response) {
            var data = response.data;
            resolve(data);
          }, reject);
        });
      });
    }

    /**
     * Returns workflow output according to inputs
     * @param {string}                   workflowId    Workflow id
     * @param {object[]|object|string}   inputs    An array of objects/object/string pointing to an image resource. A string can either be a url or base64 image bytes. Object keys explained below:
     *    @param {object}                  inputs[].image     Object with keys explained below:
     *       @param {string}                 inputs[].image.(url|base64)  Can be a publicly accessibly url or base64 string representing image bytes (required)
     * @param {object} config An object with keys explained below.
     *   @param {float} config.minValue The minimum confidence threshold that a result must meet. From 0.0 to 1.0
     *   @param {number} config.maxConcepts The maximum number of concepts to return
     */

  }, {
    key: 'predict',
    value: function predict(workflowId, inputs) {
      var config = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};

      var url = '' + this._config.basePath + replaceVars(WORKFLOW_RESULTS_PATH, [workflowId]);
      if (checkType(/(Object|String)/, inputs)) {
        inputs = [inputs];
      }
      return wrapToken(this._config, function (headers) {
        var params = {
          inputs: inputs.map(formatInput)
        };
        if (config && Object.getOwnPropertyNames(config).length > 0) {
          params['output_config'] = (0, _utils.formatObjectForSnakeCase)(config);
        }
        return new Promise(function (resolve, reject) {
          axios.post(url, params, {
            headers: headers
          }).then(function (response) {
            var data = response.data;
            resolve(data);
          }, reject);
        });
      });
    }
  }]);

  return Workflow;
}();

module.exports = Workflow;
},{"./constants":41,"./helpers":42,"./utils":46,"axios":3}],40:[function(require,module,exports){
'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var axios = require('axios');
var Workflow = require('./Workflow');

var _require = require('./constants'),
    API = _require.API,
    replaceVars = _require.replaceVars;

var WORKFLOWS_PATH = API.WORKFLOWS_PATH,
    WORKFLOW_PATH = API.WORKFLOW_PATH;

var _require2 = require('./utils'),
    wrapToken = _require2.wrapToken;

var _require3 = require('./helpers'),
    isSuccess = _require3.isSuccess;

/**
 * class representing a collection of workflows
 * @class
 */


var Workflows = function () {
  function Workflows(_config) {
    var _this = this;

    var rawData = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];

    _classCallCheck(this, Workflows);

    this._config = _config;
    this.rawData = rawData;
    rawData.forEach(function (workflowData, index) {
      _this[index] = new Workflow(_this._config, workflowData);
    });
    this.length = rawData.length;
  }

  /**
   * Get all workflows in app
   * @param {Object}    options  Object with keys explained below: (optional)
   *   @param {Number}    options.page  The page number (optional, default: 1)
   *   @param {Number}    options.perPage  Number of images to return per page (optional, default: 20)
   * @return {Promise(Workflows, error)} A Promise that is fulfilled with an instance of Workflows or rejected with an error
   */


  _createClass(Workflows, [{
    key: 'list',
    value: function list() {
      var _this2 = this;

      var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : { page: 1, perPage: 20 };

      var url = '' + this._config.basePath + WORKFLOWS_PATH;
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.get(url, {
            headers: headers,
            params: {
              page: options.page,
              per_page: options.perPage
            }
          }).then(function (response) {
            if (isSuccess(response)) {
              resolve(new Workflows(_this2._config, response.data.workflows));
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }
  }, {
    key: 'create',
    value: function create(workflowId, config) {
      var url = '' + this._config.basePath + WORKFLOWS_PATH;
      var modelId = config.modelId;
      var modelVersionId = config.modelVersionId;
      var body = {
        workflows: [{
          id: workflowId,
          nodes: [{
            id: 'concepts',
            model: {
              id: modelId,
              model_version: {
                id: modelVersionId
              }
            }
          }]
        }]
      };

      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.post(url, body, {
            headers: headers
          }).then(function (response) {
            var workflowId = response.data.workflows[0].id;
            resolve(workflowId);
          }, reject);
        });
      });
    }
  }, {
    key: 'delete',
    value: function _delete(workflowId) {
      var url = '' + this._config.basePath + replaceVars(WORKFLOW_PATH, [workflowId]);
      return wrapToken(this._config, function (headers) {
        return new Promise(function (resolve, reject) {
          axios.delete(url, {
            headers: headers
          }).then(function (response) {
            var data = response.data;
            resolve(data);
          }, reject);
        });
      });
    }
  }]);

  return Workflows;
}();

;

module.exports = Workflows;
},{"./Workflow":39,"./constants":41,"./helpers":42,"./utils":46,"axios":3}],41:[function(require,module,exports){
'use strict';

var MAX_BATCH_SIZE = 128;
var GEO_LIMIT_TYPES = ['withinMiles', 'withinKilometers', 'withinRadians', 'withinDegrees'];
var SYNC_TIMEOUT = 360000; // 6 minutes
var MODEL_QUEUED_FOR_TRAINING = '21103';
var MODEL_TRAINING = '21101';
var POLLTIME = 2000;

module.exports = {
  API: {
    TOKEN_PATH: '/token',
    MODELS_PATH: '/models',
    MODEL_PATH: '/models/$0',
    MODEL_VERSIONS_PATH: '/models/$0/versions',
    MODEL_VERSION_PATH: '/models/$0/versions/$1',
    MODEL_PATCH_PATH: '/models/$0/output_info/data/concepts',
    MODEL_OUTPUT_PATH: '/models/$0/output_info',
    MODEL_VERSION_OUTPUT_PATH: '/models/$0/versions/$1/output_info',
    MODEL_SEARCH_PATH: '/models/searches',
    MODEL_FEEDBACK_PATH: '/models/$0/feedback',
    MODEL_VERSION_FEEDBACK_PATH: '/models/$0/versions/$1/feedback',
    PREDICT_PATH: '/models/$0/outputs',
    VERSION_PREDICT_PATH: '/models/$0/versions/$1/outputs',
    CONCEPTS_PATH: '/concepts',
    CONCEPT_PATH: '/concepts/$0',
    CONCEPT_SEARCH_PATH: '/concepts/searches',
    MODEL_INPUTS_PATH: '/models/$0/inputs',
    MODEL_VERSION_INPUTS_PATH: '/models/$0/versions/$1/inputs',
    MODEL_VERSION_METRICS_PATH: '/models/$0/versions/$1/metrics',
    INPUTS_PATH: '/inputs',
    INPUT_PATH: '/inputs/$0',
    INPUTS_STATUS_PATH: '/inputs/status',
    SEARCH_PATH: '/searches',
    SEARCH_FEEDBACK_PATH: '/searches/feedback',
    WORKFLOWS_PATH: '/workflows',
    WORKFLOW_PATH: '/workflows/$0',
    WORKFLOW_RESULTS_PATH: '/workflows/$0/results'
  },
  ERRORS: {
    paramsRequired: function paramsRequired(param) {
      var paramList = Array.isArray(param) ? param : [param];
      return new Error('The following ' + (paramList.length > 1 ? 'params are' : 'param is') + ' required: ' + paramList.join(', '));
    },
    MAX_INPUTS: new Error('Number of inputs passed exceeded max of ' + MAX_BATCH_SIZE),
    INVALID_GEOLIMIT_TYPE: new Error('Incorrect geo_limit type. Value must be any of the following: ' + GEO_LIMIT_TYPES.join(', ')),
    INVALID_DELETE_ARGS: new Error('Wrong arguments passed. You can only delete all models (provide no arguments), delete select models (provide list of ids),\n    delete a single model (providing a single id) or delete a model version (provide a single id and version id)')
  },
  STATUS: {
    MODEL_QUEUED_FOR_TRAINING: MODEL_QUEUED_FOR_TRAINING,
    MODEL_TRAINING: MODEL_TRAINING
  },
  // var replacement must be given in order
  replaceVars: function replaceVars(path) {
    var vars = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];

    var newPath = path;
    vars.forEach(function (val, index) {
      if (index === 0) {
        val = encodeURIComponent(val);
      }
      newPath = newPath.replace(new RegExp('\\$' + index, 'g'), val);
    });
    return newPath;
  },
  getBasePath: function getBasePath() {
    var apiEndpoint = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 'https://api.clarifai.com';
    var userId = arguments[1];
    var appId = arguments[2];

    if (!userId || !appId) {
      return apiEndpoint + '/v2';
    }
    return apiEndpoint + '/v2/users/' + userId + '/apps/' + appId;
  },
  GEO_LIMIT_TYPES: GEO_LIMIT_TYPES,
  MAX_BATCH_SIZE: MAX_BATCH_SIZE,
  SYNC_TIMEOUT: SYNC_TIMEOUT,
  POLLTIME: POLLTIME
};
},{}],42:[function(require,module,exports){
'use strict';

var SUCCESS_CODES = [200, 201];

module.exports = {
  isSuccess: function isSuccess(response) {
    return SUCCESS_CODES.indexOf(response.status) > -1;
  },
  deleteEmpty: function deleteEmpty(obj) {
    var strict = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : false;

    Object.keys(obj).forEach(function (key) {
      if (obj[key] === null || obj[key] === undefined || strict === true && (obj[key] === '' || obj[key].length === 0 || Object.keys(obj[key]).length === 0)) {
        delete obj[key];
      }
    });
  },
  clone: function clone(obj) {
    var keys = Object.keys(obj);
    var copy = {};
    keys.forEach(function (k) {
      copy[k] = obj[k];
    });
    return copy;
  },
  checkType: function checkType(regex, val) {
    if (regex instanceof RegExp === false) {
      regex = new RegExp(regex);
    }
    return regex.test(Object.prototype.toString.call(val));
  }
};
},{}],43:[function(require,module,exports){
(function (global){
'use strict';

var App = require('./App');

var _require = require('./../package.json'),
    version = _require.version;

module.exports = global.Clarifai = {
  version: version,
  App: App,
  GENERAL_MODEL: 'aaa03c23b3724a16a56b629203edc62c',
  FOOD_MODEL: 'bd367be194cf45149e75f01d59f77ba7',
  TRAVEL_MODEL: 'eee28c313d69466f836ab83287a54ed9',
  NSFW_MODEL: 'e9576d86d2004ed1a38ba0cf39ecb4b1',
  WEDDINGS_MODEL: 'c386b7a870114f4a87477c0824499348',
  WEDDING_MODEL: 'c386b7a870114f4a87477c0824499348',
  COLOR_MODEL: 'eeed0b6733a644cea07cf4c60f87ebb7',
  CLUSTER_MODEL: 'cccbe437d6e54e2bb911c6aa292fb072',
  FACE_DETECT_MODEL: 'a403429f2ddf4b49b307e318f00e528b',
  FOCUS_MODEL: 'c2cf7cecd8a6427da375b9f35fcd2381',
  LOGO_MODEL: 'c443119bf2ed4da98487520d01a0b1e3',
  DEMOGRAPHICS_MODEL: 'c0c0ac362b03416da06ab3fa36fb58e3',
  GENERAL_EMBED_MODEL: 'bbb5f41425b8468d9b7a554ff10f8581',
  FACE_EMBED_MODEL: 'd02b4508df58432fbb84e800597b8959',
  APPAREL_MODEL: 'e0be3b9d6a454f0493ac3a30784001ff',
  MODERATION_MODEL: 'd16f390eb32cad478c7ae150069bd2c6',
  TEXTURES_AND_PATTERNS: 'fbefb47f9fdb410e8ce14f24f54b47ff',
  LANDSCAPE_QUALITY: 'bec14810deb94c40a05f1f0eb3c91403',
  PORTRAIT_QUALITY: 'de9bd05cfdbf4534af151beb2a5d0953',
  CELEBRITY_MODEL: 'e466caa0619f444ab97497640cefc4dc'
};
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./../package.json":47,"./App":29}],44:[function(require,module,exports){
'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var axios = require('axios');

var _require = require('../utils'),
    wrapToken = _require.wrapToken;

var _require2 = require('../helpers'),
    isSuccess = _require2.isSuccess,
    clone = _require2.clone;

var BASE_URL = 'https://api.clarifai-moderation.com';

var Moderation = function () {
  function Moderation(_config) {
    _classCallCheck(this, Moderation);

    this._config = _config;
  }

  _createClass(Moderation, [{
    key: 'predict',
    value: function predict(modelID, imageURL) {
      return wrapToken(this._config, function (headers) {
        var url = BASE_URL + '/v2/models/' + modelID + '/outputs';
        var params = {
          inputs: [{
            data: {
              image: {
                url: imageURL
              }
            }
          }]
        };

        return new Promise(function (resolve, reject) {
          return axios.post(url, params, { headers: headers }).then(function (response) {
            if (isSuccess(response)) {
              var data = clone(response.data);
              resolve(data);
            } else {
              reject(response);
            }
          }, reject);
        });
      });
    }
  }, {
    key: 'getModerationStatus',
    value: function getModerationStatus(imageID) {
      return wrapToken(this._config, function (headers) {
        var url = BASE_URL + '/v2/inputs/' + imageID + '/outputs';
        return new Promise(function (resolve, reject) {
          return axios.get(url, { headers: headers }).then(function (response) {
            var data = clone(response.data);
            resolve(data);
          }, reject);
        });
      });
    }
  }]);

  return Moderation;
}();

module.exports = Moderation;
},{"../helpers":42,"../utils":46,"axios":3}],45:[function(require,module,exports){
'use strict';

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var Moderation = require('./Moderation');

var Solutions = function Solutions(_config) {
  _classCallCheck(this, Solutions);

  this.moderation = new Moderation(_config);
};

module.exports = Solutions;
},{"./Moderation":44}],46:[function(require,module,exports){
'use strict';

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

var Promise = require('promise');
var validUrl = require('valid-url');

var _require = require('./constants'),
    GEO_LIMIT_TYPES = _require.GEO_LIMIT_TYPES,
    ERRORS = _require.ERRORS;

var _require2 = require('./helpers'),
    checkType = _require2.checkType,
    clone = _require2.clone;

var _require3 = require('./../package.json'),
    VERSION = _require3.version;

module.exports = {
  wrapToken: function wrapToken(_config, requestFn) {
    return new Promise(function (resolve, reject) {
      if (_config.apiKey) {
        var headers = {
          Authorization: 'Key ' + _config.apiKey,
          'X-Clarifai-Client': 'js:' + VERSION
        };
        return requestFn(headers).then(resolve, reject);
      }
      if (_config.sessionToken) {
        var _headers = {
          'X-Clarifai-Session-Token': _config.sessionToken,
          'X-Clarifai-Client': 'js:' + VERSION
        };
        return requestFn(_headers).then(resolve, reject);
      }
      _config.token().then(function (token) {
        var headers = {
          Authorization: 'Bearer ' + token.accessToken,
          'X-Clarifai-Client': 'js:' + VERSION
        };
        requestFn(headers).then(resolve, reject);
      }, reject);
    });
  },
  formatModel: function formatModel() {
    var data = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

    var formatted = {};
    if (data.id === null || data.id === undefined) {
      throw ERRORS.paramsRequired('Model ID');
    }
    formatted.id = data.id;
    if (data.name) {
      formatted.name = data.name;
    }
    formatted.output_info = {};
    if (data.conceptsMutuallyExclusive !== undefined) {
      formatted.output_info.output_config = formatted.output_info.output_config || {};
      formatted.output_info.output_config.concepts_mutually_exclusive = !!data.conceptsMutuallyExclusive;
    }
    if (data.closedEnvironment !== undefined) {
      formatted.output_info.output_config = formatted.output_info.output_config || {};
      formatted.output_info.output_config.closed_environment = !!data.closedEnvironment;
    }
    if (data.concepts) {
      formatted.output_info.data = {
        concepts: data.concepts.map(module.exports.formatConcept)
      };
    }
    return formatted;
  },
  formatInput: function formatInput(data, includeImage) {
    var input = checkType(/String/, data) ? { url: data } : data;
    var formatted = {
      id: input.id || null,
      data: {}
    };
    if (input.concepts) {
      formatted.data.concepts = input.concepts;
    }
    if (input.metadata) {
      formatted.data.metadata = input.metadata;
    }
    if (input.geo) {
      formatted.data.geo = { geo_point: input.geo };
    }
    if (input.regions) {
      formatted.data.regions = input.regions;
    }
    if (includeImage !== false) {
      formatted.data.image = {
        url: input.url,
        base64: input.base64,
        crop: input.crop
      };
      if (data.allowDuplicateUrl) {
        formatted.data.image.allow_duplicate_url = true;
      }
    }
    return formatted;
  },
  formatMediaPredict: function formatMediaPredict(data) {
    var type = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 'image';

    var media = void 0;
    if (checkType(/String/, data)) {
      if (validUrl.isWebUri(data)) {
        media = {
          url: data
        };
      } else {
        media = {
          base64: data
        };
      }
    } else {
      media = Object.assign({}, data);
    }

    // Users can specify their own id to distinguish batch results
    var id = void 0;
    if (media.id) {
      id = media.id;
      delete media.id;
    }

    var object = {
      data: _defineProperty({}, type, media)
    };

    if (id) {
      object.id = id;
    }

    return object;
  },
  formatImagesSearch: function formatImagesSearch(image) {
    var imageQuery = void 0;
    var input = { input: { data: {} } };
    var formatted = [];
    if (checkType(/String/, image)) {
      imageQuery = { url: image };
    } else {
      imageQuery = image.url || image.base64 ? {
        image: {
          url: image.url,
          base64: image.base64,
          crop: image.crop
        }
      } : {};
    }

    input.input.data = imageQuery;
    if (image.id) {
      input.input.id = image.id;
      input.input.data = { image: {} };
      if (image.crop) {
        input.input.data.image.crop = image.crop;
      }
    }
    if (image.metadata !== undefined) {
      input.input.data.metadata = image.metadata;
    }
    if (image.geo !== undefined) {
      if (checkType(/Array/, image.geo)) {
        input.input.data.geo = {
          geo_box: image.geo.map(function (p) {
            return { geo_point: p };
          })
        };
      } else if (checkType(/Object/, image.geo)) {
        if (GEO_LIMIT_TYPES.indexOf(image.geo.type) === -1) {
          throw ERRORS.INVALID_GEOLIMIT_TYPE;
        }
        input.input.data.geo = {
          geo_point: {
            latitude: image.geo.latitude,
            longitude: image.geo.longitude
          },
          geo_limit: {
            type: image.geo.type,
            value: image.geo.value
          }
        };
      }
    }
    if (image.type !== 'input' && input.input.data.image) {
      if (input.input.data.metadata || input.input.data.geo) {
        var dataCopy = { input: { data: clone(input.input.data) } };
        var imageCopy = { input: { data: clone(input.input.data) } };
        delete dataCopy.input.data.image;
        delete imageCopy.input.data.metadata;
        delete imageCopy.input.data.geo;
        input = [{ output: imageCopy }, dataCopy];
      } else {
        input = [{ output: input }];
      }
    }
    formatted = formatted.concat(input);
    return formatted;
  },
  formatConcept: function formatConcept(concept) {
    var formatted = concept;
    if (checkType(/String/, concept)) {
      formatted = {
        id: concept
      };
    }
    return formatted;
  },
  formatConceptsSearch: function formatConceptsSearch(query) {
    if (checkType(/String/, query)) {
      query = { id: query };
    }
    var v = {};
    var type = query.type === 'input' ? 'input' : 'output';
    delete query.type;
    v[type] = {
      data: {
        concepts: [query]
      }
    };
    return v;
  },
  formatObjectForSnakeCase: function formatObjectForSnakeCase(obj) {
    return Object.keys(obj).reduce(function (o, k) {
      o[k.replace(/([A-Z])/g, function (r) {
        return '_' + r.toLowerCase();
      })] = obj[k];
      return o;
    }, {});
  }
};
},{"./../package.json":47,"./constants":41,"./helpers":42,"promise":49,"valid-url":57}],47:[function(require,module,exports){
module.exports={
  "_from": "clarifai",
  "_id": "clarifai@2.9.1",
  "_inBundle": false,
  "_integrity": "sha512-xUxl0bNhBTRn93BBjzYG3nQ/BRZI5VcAZOn1hsukTEFgE31grtegztMT26AbFdmWkCJin1dM6TaC4APSHYs/Ug==",
  "_location": "/clarifai",
  "_phantomChildren": {},
  "_requested": {
    "type": "tag",
    "registry": true,
    "raw": "clarifai",
    "name": "clarifai",
    "escapedName": "clarifai",
    "rawSpec": "",
    "saveSpec": null,
    "fetchSpec": "latest"
  },
  "_requiredBy": [
    "#USER",
    "/"
  ],
  "_resolved": "https://registry.npmjs.org/clarifai/-/clarifai-2.9.1.tgz",
  "_shasum": "7dd21c3265de34b557ee3a216cb31e2908c6944c",
  "_spec": "clarifai",
  "_where": "C:\\Users\\thinkpad\\Desktop\\JS PROJECTS\\machine-learning-app",
  "author": {
    "name": "Clarifai Inc."
  },
  "bugs": {
    "url": "https://github.com/Clarifai/clarifai-javascript/issues"
  },
  "bundleDependencies": false,
  "dependencies": {
    "axios": ">=0.11.1 <2",
    "promise": "^7.1.1",
    "valid-url": "^1.0.9"
  },
  "deprecated": false,
  "description": "Official Clarifai Javascript SDK",
  "devDependencies": {
    "axios-mock-adapter": "^1.16.0",
    "babel-eslint": "^6.1.2",
    "babel-preset-es2015": "^6.14.0",
    "babel-register": "^6.14.0",
    "babelify": "^7.3.0",
    "del": "^2.0.2",
    "envify": "^3.4.0",
    "gulp": "^3.9.1",
    "gulp-babel": "^6.1.2",
    "gulp-browserify": "^0.5.1",
    "gulp-eslint": "^2.0.0",
    "gulp-insert": "^0.5.0",
    "gulp-jasmine": "^4.0.0",
    "gulp-notify": "2.2.0",
    "gulp-rename": "^1.2.2",
    "gulp-replace-task": "^0.11.0",
    "gulp-uglify": "^1.4.1",
    "gulp-util": "^3.0.6",
    "jsdoc": "^3.4.1",
    "minami": "^1.1.1",
    "release-it": "^2.9.0"
  },
  "homepage": "https://github.com/Clarifai/clarifai-javascript#readme",
  "license": "Apache-2.0",
  "main": "dist/index.js",
  "name": "clarifai",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/Clarifai/clarifai-javascript.git"
  },
  "scripts": {
    "build": "npm run clean && gulp build && npm run jsdoc",
    "clean": "gulp cleanbuild",
    "jsdoc": "jsdoc src/* -t node_modules/minami -d docs/$npm_package_version && jsdoc src/* -t node_modules/minami -d docs/latest",
    "release": "release-it",
    "test": "gulp test",
    "unittest": "gulp unittest",
    "watch": "gulp watch"
  },
  "version": "2.9.1"
}

},{}],48:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],49:[function(require,module,exports){
'use strict';

module.exports = require('./lib')

},{"./lib":54}],50:[function(require,module,exports){
'use strict';

var asap = require('asap/raw');

function noop() {}

// States:
//
// 0 - pending
// 1 - fulfilled with _value
// 2 - rejected with _value
// 3 - adopted the state of another promise, _value
//
// once the state is no longer pending (0) it is immutable

// All `_` prefixed properties will be reduced to `_{random number}`
// at build time to obfuscate them and discourage their use.
// We don't use symbols or Object.defineProperty to fully hide them
// because the performance isn't good enough.


// to avoid using try/catch inside critical functions, we
// extract them to here.
var LAST_ERROR = null;
var IS_ERROR = {};
function getThen(obj) {
  try {
    return obj.then;
  } catch (ex) {
    LAST_ERROR = ex;
    return IS_ERROR;
  }
}

function tryCallOne(fn, a) {
  try {
    return fn(a);
  } catch (ex) {
    LAST_ERROR = ex;
    return IS_ERROR;
  }
}
function tryCallTwo(fn, a, b) {
  try {
    fn(a, b);
  } catch (ex) {
    LAST_ERROR = ex;
    return IS_ERROR;
  }
}

module.exports = Promise;

function Promise(fn) {
  if (typeof this !== 'object') {
    throw new TypeError('Promises must be constructed via new');
  }
  if (typeof fn !== 'function') {
    throw new TypeError('Promise constructor\'s argument is not a function');
  }
  this._40 = 0;
  this._65 = 0;
  this._55 = null;
  this._72 = null;
  if (fn === noop) return;
  doResolve(fn, this);
}
Promise._37 = null;
Promise._87 = null;
Promise._61 = noop;

Promise.prototype.then = function(onFulfilled, onRejected) {
  if (this.constructor !== Promise) {
    return safeThen(this, onFulfilled, onRejected);
  }
  var res = new Promise(noop);
  handle(this, new Handler(onFulfilled, onRejected, res));
  return res;
};

function safeThen(self, onFulfilled, onRejected) {
  return new self.constructor(function (resolve, reject) {
    var res = new Promise(noop);
    res.then(resolve, reject);
    handle(self, new Handler(onFulfilled, onRejected, res));
  });
}
function handle(self, deferred) {
  while (self._65 === 3) {
    self = self._55;
  }
  if (Promise._37) {
    Promise._37(self);
  }
  if (self._65 === 0) {
    if (self._40 === 0) {
      self._40 = 1;
      self._72 = deferred;
      return;
    }
    if (self._40 === 1) {
      self._40 = 2;
      self._72 = [self._72, deferred];
      return;
    }
    self._72.push(deferred);
    return;
  }
  handleResolved(self, deferred);
}

function handleResolved(self, deferred) {
  asap(function() {
    var cb = self._65 === 1 ? deferred.onFulfilled : deferred.onRejected;
    if (cb === null) {
      if (self._65 === 1) {
        resolve(deferred.promise, self._55);
      } else {
        reject(deferred.promise, self._55);
      }
      return;
    }
    var ret = tryCallOne(cb, self._55);
    if (ret === IS_ERROR) {
      reject(deferred.promise, LAST_ERROR);
    } else {
      resolve(deferred.promise, ret);
    }
  });
}
function resolve(self, newValue) {
  // Promise Resolution Procedure: https://github.com/promises-aplus/promises-spec#the-promise-resolution-procedure
  if (newValue === self) {
    return reject(
      self,
      new TypeError('A promise cannot be resolved with itself.')
    );
  }
  if (
    newValue &&
    (typeof newValue === 'object' || typeof newValue === 'function')
  ) {
    var then = getThen(newValue);
    if (then === IS_ERROR) {
      return reject(self, LAST_ERROR);
    }
    if (
      then === self.then &&
      newValue instanceof Promise
    ) {
      self._65 = 3;
      self._55 = newValue;
      finale(self);
      return;
    } else if (typeof then === 'function') {
      doResolve(then.bind(newValue), self);
      return;
    }
  }
  self._65 = 1;
  self._55 = newValue;
  finale(self);
}

function reject(self, newValue) {
  self._65 = 2;
  self._55 = newValue;
  if (Promise._87) {
    Promise._87(self, newValue);
  }
  finale(self);
}
function finale(self) {
  if (self._40 === 1) {
    handle(self, self._72);
    self._72 = null;
  }
  if (self._40 === 2) {
    for (var i = 0; i < self._72.length; i++) {
      handle(self, self._72[i]);
    }
    self._72 = null;
  }
}

function Handler(onFulfilled, onRejected, promise){
  this.onFulfilled = typeof onFulfilled === 'function' ? onFulfilled : null;
  this.onRejected = typeof onRejected === 'function' ? onRejected : null;
  this.promise = promise;
}

/**
 * Take a potentially misbehaving resolver function and make sure
 * onFulfilled and onRejected are only called once.
 *
 * Makes no guarantees about asynchrony.
 */
function doResolve(fn, promise) {
  var done = false;
  var res = tryCallTwo(fn, function (value) {
    if (done) return;
    done = true;
    resolve(promise, value);
  }, function (reason) {
    if (done) return;
    done = true;
    reject(promise, reason);
  });
  if (!done && res === IS_ERROR) {
    done = true;
    reject(promise, LAST_ERROR);
  }
}

},{"asap/raw":2}],51:[function(require,module,exports){
'use strict';

var Promise = require('./core.js');

module.exports = Promise;
Promise.prototype.done = function (onFulfilled, onRejected) {
  var self = arguments.length ? this.then.apply(this, arguments) : this;
  self.then(null, function (err) {
    setTimeout(function () {
      throw err;
    }, 0);
  });
};

},{"./core.js":50}],52:[function(require,module,exports){
'use strict';

//This file contains the ES6 extensions to the core Promises/A+ API

var Promise = require('./core.js');

module.exports = Promise;

/* Static Functions */

var TRUE = valuePromise(true);
var FALSE = valuePromise(false);
var NULL = valuePromise(null);
var UNDEFINED = valuePromise(undefined);
var ZERO = valuePromise(0);
var EMPTYSTRING = valuePromise('');

function valuePromise(value) {
  var p = new Promise(Promise._61);
  p._65 = 1;
  p._55 = value;
  return p;
}
Promise.resolve = function (value) {
  if (value instanceof Promise) return value;

  if (value === null) return NULL;
  if (value === undefined) return UNDEFINED;
  if (value === true) return TRUE;
  if (value === false) return FALSE;
  if (value === 0) return ZERO;
  if (value === '') return EMPTYSTRING;

  if (typeof value === 'object' || typeof value === 'function') {
    try {
      var then = value.then;
      if (typeof then === 'function') {
        return new Promise(then.bind(value));
      }
    } catch (ex) {
      return new Promise(function (resolve, reject) {
        reject(ex);
      });
    }
  }
  return valuePromise(value);
};

Promise.all = function (arr) {
  var args = Array.prototype.slice.call(arr);

  return new Promise(function (resolve, reject) {
    if (args.length === 0) return resolve([]);
    var remaining = args.length;
    function res(i, val) {
      if (val && (typeof val === 'object' || typeof val === 'function')) {
        if (val instanceof Promise && val.then === Promise.prototype.then) {
          while (val._65 === 3) {
            val = val._55;
          }
          if (val._65 === 1) return res(i, val._55);
          if (val._65 === 2) reject(val._55);
          val.then(function (val) {
            res(i, val);
          }, reject);
          return;
        } else {
          var then = val.then;
          if (typeof then === 'function') {
            var p = new Promise(then.bind(val));
            p.then(function (val) {
              res(i, val);
            }, reject);
            return;
          }
        }
      }
      args[i] = val;
      if (--remaining === 0) {
        resolve(args);
      }
    }
    for (var i = 0; i < args.length; i++) {
      res(i, args[i]);
    }
  });
};

Promise.reject = function (value) {
  return new Promise(function (resolve, reject) {
    reject(value);
  });
};

Promise.race = function (values) {
  return new Promise(function (resolve, reject) {
    values.forEach(function(value){
      Promise.resolve(value).then(resolve, reject);
    });
  });
};

/* Prototype Methods */

Promise.prototype['catch'] = function (onRejected) {
  return this.then(null, onRejected);
};

},{"./core.js":50}],53:[function(require,module,exports){
'use strict';

var Promise = require('./core.js');

module.exports = Promise;
Promise.prototype['finally'] = function (f) {
  return this.then(function (value) {
    return Promise.resolve(f()).then(function () {
      return value;
    });
  }, function (err) {
    return Promise.resolve(f()).then(function () {
      throw err;
    });
  });
};

},{"./core.js":50}],54:[function(require,module,exports){
'use strict';

module.exports = require('./core.js');
require('./done.js');
require('./finally.js');
require('./es6-extensions.js');
require('./node-extensions.js');
require('./synchronous.js');

},{"./core.js":50,"./done.js":51,"./es6-extensions.js":52,"./finally.js":53,"./node-extensions.js":55,"./synchronous.js":56}],55:[function(require,module,exports){
'use strict';

// This file contains then/promise specific extensions that are only useful
// for node.js interop

var Promise = require('./core.js');
var asap = require('asap');

module.exports = Promise;

/* Static Functions */

Promise.denodeify = function (fn, argumentCount) {
  if (
    typeof argumentCount === 'number' && argumentCount !== Infinity
  ) {
    return denodeifyWithCount(fn, argumentCount);
  } else {
    return denodeifyWithoutCount(fn);
  }
};

var callbackFn = (
  'function (err, res) {' +
  'if (err) { rj(err); } else { rs(res); }' +
  '}'
);
function denodeifyWithCount(fn, argumentCount) {
  var args = [];
  for (var i = 0; i < argumentCount; i++) {
    args.push('a' + i);
  }
  var body = [
    'return function (' + args.join(',') + ') {',
    'var self = this;',
    'return new Promise(function (rs, rj) {',
    'var res = fn.call(',
    ['self'].concat(args).concat([callbackFn]).join(','),
    ');',
    'if (res &&',
    '(typeof res === "object" || typeof res === "function") &&',
    'typeof res.then === "function"',
    ') {rs(res);}',
    '});',
    '};'
  ].join('');
  return Function(['Promise', 'fn'], body)(Promise, fn);
}
function denodeifyWithoutCount(fn) {
  var fnLength = Math.max(fn.length - 1, 3);
  var args = [];
  for (var i = 0; i < fnLength; i++) {
    args.push('a' + i);
  }
  var body = [
    'return function (' + args.join(',') + ') {',
    'var self = this;',
    'var args;',
    'var argLength = arguments.length;',
    'if (arguments.length > ' + fnLength + ') {',
    'args = new Array(arguments.length + 1);',
    'for (var i = 0; i < arguments.length; i++) {',
    'args[i] = arguments[i];',
    '}',
    '}',
    'return new Promise(function (rs, rj) {',
    'var cb = ' + callbackFn + ';',
    'var res;',
    'switch (argLength) {',
    args.concat(['extra']).map(function (_, index) {
      return (
        'case ' + (index) + ':' +
        'res = fn.call(' + ['self'].concat(args.slice(0, index)).concat('cb').join(',') + ');' +
        'break;'
      );
    }).join(''),
    'default:',
    'args[argLength] = cb;',
    'res = fn.apply(self, args);',
    '}',
    
    'if (res &&',
    '(typeof res === "object" || typeof res === "function") &&',
    'typeof res.then === "function"',
    ') {rs(res);}',
    '});',
    '};'
  ].join('');

  return Function(
    ['Promise', 'fn'],
    body
  )(Promise, fn);
}

Promise.nodeify = function (fn) {
  return function () {
    var args = Array.prototype.slice.call(arguments);
    var callback =
      typeof args[args.length - 1] === 'function' ? args.pop() : null;
    var ctx = this;
    try {
      return fn.apply(this, arguments).nodeify(callback, ctx);
    } catch (ex) {
      if (callback === null || typeof callback == 'undefined') {
        return new Promise(function (resolve, reject) {
          reject(ex);
        });
      } else {
        asap(function () {
          callback.call(ctx, ex);
        })
      }
    }
  }
};

Promise.prototype.nodeify = function (callback, ctx) {
  if (typeof callback != 'function') return this;

  this.then(function (value) {
    asap(function () {
      callback.call(ctx, null, value);
    });
  }, function (err) {
    asap(function () {
      callback.call(ctx, err);
    });
  });
};

},{"./core.js":50,"asap":1}],56:[function(require,module,exports){
'use strict';

var Promise = require('./core.js');

module.exports = Promise;
Promise.enableSynchronous = function () {
  Promise.prototype.isPending = function() {
    return this.getState() == 0;
  };

  Promise.prototype.isFulfilled = function() {
    return this.getState() == 1;
  };

  Promise.prototype.isRejected = function() {
    return this.getState() == 2;
  };

  Promise.prototype.getValue = function () {
    if (this._65 === 3) {
      return this._55.getValue();
    }

    if (!this.isFulfilled()) {
      throw new Error('Cannot get a value of an unfulfilled promise.');
    }

    return this._55;
  };

  Promise.prototype.getReason = function () {
    if (this._65 === 3) {
      return this._55.getReason();
    }

    if (!this.isRejected()) {
      throw new Error('Cannot get a rejection reason of a non-rejected promise.');
    }

    return this._55;
  };

  Promise.prototype.getState = function () {
    if (this._65 === 3) {
      return this._55.getState();
    }
    if (this._65 === -1 || this._65 === -2) {
      return 0;
    }

    return this._65;
  };
};

Promise.disableSynchronous = function() {
  Promise.prototype.isPending = undefined;
  Promise.prototype.isFulfilled = undefined;
  Promise.prototype.isRejected = undefined;
  Promise.prototype.getValue = undefined;
  Promise.prototype.getReason = undefined;
  Promise.prototype.getState = undefined;
};

},{"./core.js":50}],57:[function(require,module,exports){
(function(module) {
    'use strict';

    module.exports.is_uri = is_iri;
    module.exports.is_http_uri = is_http_iri;
    module.exports.is_https_uri = is_https_iri;
    module.exports.is_web_uri = is_web_iri;
    // Create aliases
    module.exports.isUri = is_iri;
    module.exports.isHttpUri = is_http_iri;
    module.exports.isHttpsUri = is_https_iri;
    module.exports.isWebUri = is_web_iri;


    // private function
    // internal URI spitter method - direct from RFC 3986
    var splitUri = function(uri) {
        var splitted = uri.match(/(?:([^:\/?#]+):)?(?:\/\/([^\/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?/);
        return splitted;
    };

    function is_iri(value) {
        if (!value) {
            return;
        }

        // check for illegal characters
        if (/[^a-z0-9\:\/\?\#\[\]\@\!\$\&\'\(\)\*\+\,\;\=\.\-\_\~\%]/i.test(value)) return;

        // check for hex escapes that aren't complete
        if (/%[^0-9a-f]/i.test(value)) return;
        if (/%[0-9a-f](:?[^0-9a-f]|$)/i.test(value)) return;

        var splitted = [];
        var scheme = '';
        var authority = '';
        var path = '';
        var query = '';
        var fragment = '';
        var out = '';

        // from RFC 3986
        splitted = splitUri(value);
        scheme = splitted[1]; 
        authority = splitted[2];
        path = splitted[3];
        query = splitted[4];
        fragment = splitted[5];

        // scheme and path are required, though the path can be empty
        if (!(scheme && scheme.length && path.length >= 0)) return;

        // if authority is present, the path must be empty or begin with a /
        if (authority && authority.length) {
            if (!(path.length === 0 || /^\//.test(path))) return;
        } else {
            // if authority is not present, the path must not start with //
            if (/^\/\//.test(path)) return;
        }

        // scheme must begin with a letter, then consist of letters, digits, +, ., or -
        if (!/^[a-z][a-z0-9\+\-\.]*$/.test(scheme.toLowerCase()))  return;

        // re-assemble the URL per section 5.3 in RFC 3986
        out += scheme + ':';
        if (authority && authority.length) {
            out += '//' + authority;
        }

        out += path;

        if (query && query.length) {
            out += '?' + query;
        }

        if (fragment && fragment.length) {
            out += '#' + fragment;
        }

        return out;
    }

    function is_http_iri(value, allowHttps) {
        if (!is_iri(value)) {
            return;
        }

        var splitted = [];
        var scheme = '';
        var authority = '';
        var path = '';
        var port = '';
        var query = '';
        var fragment = '';
        var out = '';

        // from RFC 3986
        splitted = splitUri(value);
        scheme = splitted[1]; 
        authority = splitted[2];
        path = splitted[3];
        query = splitted[4];
        fragment = splitted[5];

        if (!scheme)  return;

        if(allowHttps) {
            if (scheme.toLowerCase() != 'https') return;
        } else {
            if (scheme.toLowerCase() != 'http') return;
        }

        // fully-qualified URIs must have an authority section that is
        // a valid host
        if (!authority) {
            return;
        }

        // enable port component
        if (/:(\d+)$/.test(authority)) {
            port = authority.match(/:(\d+)$/)[0];
            authority = authority.replace(/:\d+$/, '');
        }

        out += scheme + ':';
        out += '//' + authority;
        
        if (port) {
            out += port;
        }
        
        out += path;
        
        if(query && query.length){
            out += '?' + query;
        }

        if(fragment && fragment.length){
            out += '#' + fragment;
        }
        
        return out;
    }

    function is_https_iri(value) {
        return is_http_iri(value, true);
    }

    function is_web_iri(value) {
        return (is_http_iri(value) || is_https_iri(value));
    }

})(module);

},{}],58:[function(require,module,exports){

const textElement = document.getElementById('text');
const formElement = document.getElementById('form');
const imgElement = document.getElementById('img');
const showElement = document.getElementById('show');
const toggleSwitch = document.querySelector('input[type="checkbox"]');
const icon = document.getElementById('icon');
const toggleText = document.querySelector('.toggle-text');
const Clarifai = require('clarifai');
const dark_mode = "dark";
const light_mode = "light";

//Dark & Light Switcher
function switcherDarkLight(variable) {
    variable === "dark"
        ? document.documentElement.setAttribute('data-theme', 'dark')
        : document.documentElement.setAttribute('data-theme', 'light');

    variable === "dark"
        ? icon.className = "fas fa-moon"
        : icon.className = "fas fa-sun";

    variable === "dark"
        ? icon.style.color = "white"
        : icon.style.color = "black";

    variable === "dark"
        ? toggleText.textContent = "Dark Mode"
        : toggleText.textContent = "Light Mode";
}
// Theme Switcher
function switchTheme(event) {
    if (event.target.checked) {
        switcherDarkLight(dark_mode);
        localStorage.setItem('theme', 'dark');
    } else {
        switcherDarkLight(light_mode)
        localStorage.setItem('theme', 'light');
    }
}
// Calculating the position elements for the image
const calculateFaceLocation = (data) => {
    const clarifaiFace = data.outputs[0].data.regions[0].region_info.bounding_box;
    const width = Number(imgElement.width);
    const height = Number(imgElement.height);
    const box = document.getElementById('bounding-box');
    const elementPosition = {
        leftCol: clarifaiFace.left_col * width,
        topRow: clarifaiFace.top_row * height,
        rightCol: width - (clarifaiFace.right_col * width),
        bottomRow: height - (clarifaiFace.bottom_row * height)
    }
    box.style.left = `${elementPosition.leftCol}px`;
    box.style.right = `${elementPosition.rightCol}px`;
    box.style.bottom = `${elementPosition.bottomRow}px`;
    box.style.top = `${elementPosition.topRow}px`;

}
// Sending the image to the API
const sendData = () => {
    const app = new Clarifai.App({
        apiKey: 'acd573ddf7df4d409a06eb22e1768f6b'
    });

    app.models.predict(Clarifai.FACE_DETECT_MODEL, textElement.value)
        .then(response => console.log(calculateFaceLocation(response)))
        .catch(e => alert(e))
}

const currentTheme = localStorage.getItem('theme');
if (currentTheme) {
    document.documentElement.setAttribute('data-theme', currentTheme);
    if (currentTheme === "dark") {
        toggleSwitch.checked = true;
        switcherDarkLight(dark_mode);
        localStorage.setItem('theme', 'dark');
    }
}

// Listener
formElement.addEventListener('submit', (e) => {
    e.preventDefault();
    imgElement.src = textElement.value;
    sendData();
});


toggleSwitch.addEventListener('change', switchTheme);


},{"clarifai":43}]},{},[58]);
