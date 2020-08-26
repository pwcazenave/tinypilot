"use strict";

const keyboardSocket = io();
let poweringDown = false;
let connectedToKeyboardService = false;
// The OS and browser capture some key combinations that involve modifier keys
// before they can reach JavaScript, so allow the user to set them manually.
let manualModifiers = {
  meta: false,
  alt: false,
  shift: false,
  ctrl: false,
};
let keystrokeId = 0;
const processingQueue = [];

// A map of keycodes to booleans indicating whether the key is currently pressed.
let keyState = {};

function hideElementById(id) {
  document.getElementById(id).style.display = "none";
}

function showElementById(id, display = "block") {
  document.getElementById(id).style.display = display;
}

function shouldDisplayKeyHistory() {
  return document.getElementById("recent-keys").style.visibility !== "hidden";
}

// Limit display of recent keys to the last N keys, where limit = N.
function limitRecentKeys(limit) {
  const recentKeysDiv = document.getElementById("recent-keys");
  while (recentKeysDiv.childElementCount > limit) {
    recentKeysDiv.removeChild(recentKeysDiv.firstChild);
  }
}

function addKeyCard(key, keystrokeId) {
  if (!shouldDisplayKeyHistory()) {
    return;
  }
  const card = document.createElement("div");
  card.classList.add("key-card");
  let keyLabel = key;
  if (key === " ") {
    keyLabel = "Space";
  }
  card.style.fontSize = `${1.1 - 0.08 * keyLabel.length}em`;
  card.innerText = keyLabel;
  card.setAttribute("keystroke-id", keystrokeId);
  document.getElementById("recent-keys").appendChild(card);
  limitRecentKeys(10);
}

function updateKeyStatus(keystrokeId, success) {
  if (!shouldDisplayKeyHistory()) {
    return;
  }
  const recentKeysDiv = document.getElementById("recent-keys");
  const cards = recentKeysDiv.children;
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (parseInt(card.getAttribute("keystroke-id")) === keystrokeId) {
      if (success) {
        card.classList.add("processed-key-card");
      } else {
        card.classList.add("unsupported-key-card");
      }
      return;
    }
  }
}

function showError(errorType, errorMessage) {
  document.getElementById("error-type").innerText = errorType;
  document.getElementById("error-message").innerText = errorMessage;
  showElementById("error-panel");
}

function hideErrorIfType(errorType) {
  if (document.getElementById("error-type").innerText === errorType) {
    hideElementById("error-panel");
  }
}

function displayPoweringDownUI(restart) {
  for (const elementId of [
    "error-panel",
    "remote-screen",
    "keystroke-history",
    "shutdown-confirmation-panel",
  ]) {
    hideElementById(elementId);
  }
  const shutdownMessage = document.createElement("h2");
  if (restart) {
    shutdownMessage.innerText = "Restarting TinyPilot Device...";
  } else {
    shutdownMessage.innerText = "Shutting down TinyPilot Device...";
  }

  document.querySelector(".page-content").appendChild(shutdownMessage);
}

function getCsrfToken() {
  return document
    .querySelector("meta[name='csrf-token']")
    .getAttribute("content");
}

function sendShutdownRequest(restart) {
  let route = "/shutdown";
  if (restart) {
    route = "/restart";
  }
  fetch(route, {
    method: "POST",
    headers: {
      "X-CSRFToken": getCsrfToken(),
    },
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
  })
    .then((response) => {
      // A 502 usually means that nginx shutdown before it could process the
      // response. Treat this as success.
      if (response.status === 502) {
        return Promise.resolve({});
      }
      if (response.status !== 200) {
        // See if the error response is JSON.
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
          return response.json().then((data) => {
            return Promise.reject(new Error(data.error));
          });
        }
        return Promise.reject(new Error(response.statusText));
      }
      return response.json();
    })
    .then((result) => {
      if (result.error) {
        return Promise.reject(new Error(result.error));
      }
      poweringDown = true;
      displayPoweringDownUI(restart);
    })
    .catch((error) => {
      // Depending on timing, the server may not respond to the shutdown request
      // because it's shutting down. If we get a NetworkError, assume the
      // shutdown succeeded.
      if (error.message.indexOf("NetworkError") >= 0) {
        poweringDown = true;
        displayPoweringDownUI(restart);
        return;
      }
      if (restart) {
        showError("Failed to restart TinyPilot device", error);
      } else {
        showError("Failed to shut down TinyPilot device", error);
      }
    });
}

function toggleManualModifier(modifier) {
  manualModifiers[modifier] = !manualModifiers[modifier];
}

function clearManualModifiers() {
  for (var modifier in manualModifiers) {
    manualModifiers[modifier] = false;
  }
  for (const button of document.getElementsByClassName("manual-modifier-btn")) {
    button.classList.remove("pressed");
    button.blur();
  }
}

function isModifierKeyCode(keyCode) {
  const modifierKeyCodes = [16, 17, 18, 91];
  return modifierKeyCodes.indexOf(keyCode) >= 0;
}

function isKeycodeAlreadyPressed(keyCode) {
  return keyCode in keyState && keyState[keyCode];
}

function isIgnoredKeystroke(keyCode) {
  // Ignore the keystroke if this is a modifier keycode and the modifier was
  // already pressed.
  return isModifierKeyCode(keyCode) && isKeycodeAlreadyPressed(keyCode);
}

function onKeyboardSocketConnect() {
  connectedToKeyboardService = true;
  showElementById("status-connected", "flex");
  hideElementById("status-disconnected");

  hideErrorIfType("Keyboard Connection Error");
}

function onKeyboardSocketDisconnect(reason) {
  connectedToKeyboardService = false;
  hideElementById("status-connected");
  showElementById("status-disconnected", "flex");

  // If user powered down the device, don't display an error message about
  // disconnecting from the keyboard service.
  if (poweringDown) {
    return;
  }
  showError("Keyboard Connection Error", reason);
}

function onKeyDown(evt) {
  if (!connectedToKeyboardService) {
    return;
  }
  if (isIgnoredKeystroke(evt.keyCode)) {
    return;
  }
  keyState[evt.keyCode] = true;
  if (!evt.metaKey) {
    evt.preventDefault();
    addKeyCard(evt.key, keystrokeId);
    processingQueue.push(keystrokeId);
    keystrokeId++;
  }

  let location = null;
  if (evt.location === 1) {
    location = "left";
  } else if (evt.location === 2) {
    location = "right";
  }

  keyboardSocket.emit("keystroke", {
    metaKey: evt.metaKey || manualModifiers.meta,
    altKey: evt.altKey || manualModifiers.alt,
    shiftKey: evt.shiftKey || manualModifiers.shift,
    ctrlKey: evt.ctrlKey || manualModifiers.ctrl,
    key: evt.key,
    keyCode: evt.keyCode,
    location: location,
  });
  clearManualModifiers();
}

function onKeyUp(evt) {
  keyState[evt.keyCode] = false;
  if (!connectedToKeyboardService) {
    return;
  }
  if (isModifierKeyCode(evt.keyCode)) {
    keyboardSocket.emit("keyRelease");
  }
}

function onManualModifierButtonClicked(evt) {
  toggleManualModifier(evt.target.getAttribute("modifier"));
  if (evt.target.classList.contains("pressed")) {
    evt.target.classList.remove("pressed");
  } else {
    evt.target.classList.add("pressed");
  }
  document.getElementById("app").focus();
}

function onDisplayHistoryChanged(evt) {
  if (evt.target.checked) {
    document.getElementById("recent-keys").style.visibility = "visible";
  } else {
    document.getElementById("recent-keys").style.visibility = "hidden";
    limitRecentKeys(0);
  }
}

function onKeyDownInPasteMode(e) {
  // Return false on Ctrl by itself or Ctrl+V because otherwise we capture the
  // event before the paste event can occur.
  if (e.ctrlKey && (e.keyCode === 17 || e.keyCode === 86)) {
    return false;
  }
  // Treat any other key as cancellation of the paste.
  hideElementById("paste-overlay");
  // Return control to normal input.
  document.getElementById("app").focus();
}

// Place the caret (cursor) in the paste div so that we can listen for paste
// events.
function placeCaretInPasteOverlay() {
  const pasteOverlay = document.getElementById("paste-overlay");
  // This is largely copy-pasted from
  // https://stackoverflow.com/questions/4233265
  pasteOverlay.focus();

  // Move cursor to the end of the text.
  const range = document.createRange();
  range.selectNodeContents(pasteOverlay);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function onPaste(e) {
  var clipboardData, pastedData;

  // Stop data actually being pasted into div
  e.stopPropagation();
  e.preventDefault();

  // Get pasted data via clipboard API
  clipboardData = e.clipboardData || window.clipboardData;
  pastedData = clipboardData.getData("Text");
  sendPastedText(pastedData, /*updateCards =*/ true);
  hideElementById("paste-overlay");
}

function sendPastedText(pastedText, updateCards) {
  for (let i = 0; i < pastedText.length; i++) {
    // We need to identify keys which are typed with modifiers and send Shift +
    // the lowercase key.
    let isUpperCase = /^[A-Z]/;
    let modifiedSymbols = '¬!"£$%^&*()_+{}|<>?:@~';
    if (
      isUpperCase.test(pastedText[i]) ||
      modifiedSymbols.indexOf(pastedText[i]) >= 0
    ) {
      toggleManualModifier("shift");
      if (updateCards) {
        addKeyCard("Shift", keystrokeId);
        processingQueue.push(keystrokeId);
        keystrokeId++;
      }
    }
    keyboardSocket.emit("keystroke", {
      metaKey: manualModifiers.meta,
      altKey: manualModifiers.alt,
      shiftKey: manualModifiers.shift,
      ctrlKey: manualModifiers.ctrl,
      key: pastedText[i],
      keyCode: keyCodeLookup[pastedText[i].toLowerCase()],
      location: null,
    });
    if (updateCards) {
      addKeyCard(pastedText[i], keystrokeId);
      processingQueue.push(keystrokeId);
      keystrokeId++;
    }
    if (
      isUpperCase.test(pastedText[i]) ||
      modifiedSymbols.indexOf(pastedText[i]) >= 0
    ) {
      clearManualModifiers();
    }
  }
  // Give focus back to the app for normal text input.
  document.getElementById("app").focus();
}

document.onload = document.getElementById("app").focus();

document.getElementById("app").addEventListener("keydown", onKeyDown);
document.getElementById("app").addEventListener("keyup", onKeyUp);
document
  .getElementById("display-history-checkbox")
  .addEventListener("change", onDisplayHistoryChanged);
document.getElementById("power-btn").addEventListener("click", () => {
  showElementById("shutdown-confirmation-panel");
});
document.getElementById("hide-error-btn").addEventListener("click", () => {
  hideElementById("error-panel");
});
document
  .getElementById("confirm-shutdown")
  .addEventListener("click", function () {
    sendShutdownRequest(/*restart=*/ false);
  });
document
  .getElementById("confirm-restart")
  .addEventListener("click", function () {
    sendShutdownRequest(/*restart=*/ true);
  });
document.getElementById("cancel-shutdown").addEventListener("click", () => {
  hideElementById("shutdown-confirmation-panel");
});
document.getElementById("paste-btn").addEventListener("click", () => {
  showElementById("paste-overlay", "flex");
  placeCaretInPasteOverlay();
});
document.getElementById("paste-overlay").addEventListener("paste", onPaste);
document
  .getElementById("paste-overlay")
  .addEventListener("click", () => hideElementById("paste-overlay"));
document
  .getElementById("paste-overlay")
  .addEventListener("keydown", onKeyDownInPasteMode);

for (const button of document.getElementsByClassName("manual-modifier-btn")) {
  button.addEventListener("click", onManualModifierButtonClicked);
}
keyboardSocket.on("connect", onKeyboardSocketConnect);
keyboardSocket.on("disconnect", onKeyboardSocketDisconnect);
keyboardSocket.on("keystroke-received", (data) => {
  updateKeyStatus(processingQueue.shift(), data.success);
});
