import assert from "node:assert/strict";
import test from "node:test";
import { pinScrollTop, shouldPinOpenedChat, transcriptScrollAction } from "../lib/chat-scroll";

test("pinScrollTop lands on the last visible page", () => {
  assert.equal(pinScrollTop(2000, 600), 1400);
  assert.equal(pinScrollTop(400, 600), 0);
});

test("opening a chat still pins even if a stray pointer marks user scroll", () => {
  assert.equal(shouldPinOpenedChat({
    enteringChat: true,
    userDetached: false,
    userScrollInput: true,
    stickToBottom: true,
  }), true);
  assert.equal(shouldPinOpenedChat({
    enteringChat: false,
    userDetached: false,
    userScrollInput: true,
    stickToBottom: true,
  }), false);
});

test("layout growth after open re-pins instead of treating the top as a user detach", () => {
  assert.equal(transcriptScrollAction({
    enteringChat: false,
    userScrollInput: false,
    userDetached: false,
    scrolledUp: false,
    scrolledDown: false,
    atBottom: false,
    nearBottom: false,
    layoutResetToTop: false,
    stickToBottom: true,
  }), "pin");
  assert.equal(transcriptScrollAction({
    enteringChat: true,
    userScrollInput: false,
    userDetached: false,
    scrolledUp: false,
    scrolledDown: false,
    atBottom: false,
    nearBottom: false,
    layoutResetToTop: false,
    stickToBottom: false,
  }), "pin");
  assert.equal(transcriptScrollAction({
    enteringChat: false,
    userScrollInput: true,
    userDetached: false,
    scrolledUp: true,
    scrolledDown: false,
    atBottom: false,
    nearBottom: false,
    layoutResetToTop: false,
    stickToBottom: true,
  }), "detach");
});
