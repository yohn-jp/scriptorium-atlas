import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFERRED_RESIZE_MESSAGE, isDeferredResizeNotification } from '../src/frame-errors.js';

test('only native deferred-resize delivery is nonfatal; real/synthetic/sourced errors remain fatal', () => {
  const documentUrl = 'http://127.0.0.1:4174/frame.html?plugin=atlas';
  const notification = { isTrusted:true, message:DEFERRED_RESIZE_MESSAGE, error:null, filename:documentUrl, lineno:0, colno:0 };
  assert.equal(isDeferredResizeNotification(notification, documentUrl), true);
  assert.equal(isDeferredResizeNotification({...notification, filename:''}, documentUrl), true);
  for (const event of [
    {...notification, isTrusted:false},
    {...notification, error:new Error(DEFERRED_RESIZE_MESSAGE)},
    {...notification, error:DEFERRED_RESIZE_MESSAGE},
    {...notification, filename:'http://127.0.0.1:4174/assets/plugin.js'},
    {...notification, lineno:1},
    {...notification, colno:1},
    {...notification, message:'Uncaught Error: '+DEFERRED_RESIZE_MESSAGE},
    {...notification, message:'Injected frame exception'},
  ]) assert.equal(isDeferredResizeNotification(event, documentUrl), false);
});
