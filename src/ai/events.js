// Subscribes AI handlers to the app's in-process event bus (automationService.bus).
// A handler runs in the background, only while its capability is on, and an error in it is
// logged and swallowed, so it can never break or slow down the action that fired the event.
const automation = require('../services/automationService');
const logger = require('../core/logger');
const flags = require('./flags');

const subscriptions = [];

function on(events, capability, handler) {
  for (const event of [].concat(events)) {
    const listener = msg => {
      (async () => {
        if (!(await flags.isOn(capability))) return;
        await handler(msg);
      })().catch(err => logger.error(`[AI] ${event} handler failed: ${err.message}`));
    };
    automation.bus.on(event, listener);
    subscriptions.push([event, listener]);
  }
}

// Tests only: remove every AI listener.
function offAll() {
  for (const [event, listener] of subscriptions.splice(0)) automation.bus.off(event, listener);
}

module.exports = { on, offAll };
