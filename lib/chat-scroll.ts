export type TranscriptScrollAction = "pin" | "detach" | "attach" | "ignore";

export function pinScrollTop(scrollHeight: number, clientHeight: number) {
  return Math.max(0, scrollHeight - clientHeight);
}

export function shouldPinOpenedChat(options: {
  enteringChat: boolean;
  userDetached: boolean;
  userScrollInput: boolean;
  stickToBottom: boolean;
}) {
  if (options.userDetached && !options.enteringChat) return false;
  if (options.userScrollInput && !options.enteringChat) return false;
  return options.enteringChat || options.stickToBottom;
}

export function transcriptScrollAction(options: {
  enteringChat: boolean;
  userScrollInput: boolean;
  userDetached: boolean;
  scrolledUp: boolean;
  scrolledDown: boolean;
  atBottom: boolean;
  nearBottom: boolean;
  layoutResetToTop: boolean;
  stickToBottom: boolean;
}): TranscriptScrollAction {
  if (options.layoutResetToTop && (options.stickToBottom || !options.userDetached)) {
    return "pin";
  }
  if (options.scrolledUp && !options.layoutResetToTop) {
    if (options.userScrollInput) return "detach";
    if (options.enteringChat || options.stickToBottom) return "pin";
    return "detach";
  }
  if (options.enteringChat && !options.userDetached && !options.userScrollInput) {
    return "pin";
  }
  if (options.userDetached) {
    if (options.userScrollInput && options.scrolledDown && options.atBottom) return "attach";
    return "ignore";
  }
  if (options.atBottom) return "attach";
  if (!options.nearBottom) {
    if (!options.userScrollInput && (options.stickToBottom || options.enteringChat)) return "pin";
    return "detach";
  }
  return "ignore";
}
