import { guardPage, setupLogout } from "./auth.js";
import { supabase } from "./supabase.js";

const appRoot = document.body.dataset.appRoot || "../";
const scannerElementId = "qr-reader";
const scanStatus = document.querySelector("#scan-status");
const scanAgainButton = document.querySelector("#scan-again-button");
let scanner = null;
let scannerRunning = false;
let submitting = false;

function showStatus(message, kind = "info") {
  scanStatus.textContent = message;
  scanStatus.dataset.kind = kind;
}

async function stopScanner() {
  if (!scanner || !scannerRunning) return;
  try {
    await scanner.stop();
    scannerRunning = false;
  } catch {
    showStatus("The camera could not be stopped. You can close this page when you're done.", "error");
  }
}

async function handleScan(decodedText) {
  if (submitting) return;
  const token = decodedText.trim();
  if (!token || token.length > 512) {
    showStatus("That QR code doesn't look like a valid TapMark attendance code.", "error");
    return;
  }

  submitting = true;
  scanAgainButton.hidden = true;
  showStatus("Code scanned. Recording your attendance…");
  await stopScanner();

  try {
    const { error } = await supabase.rpc("mark_attendance", { token });
    if (error) {
      const errorText = error.message.toLowerCase();
      if (errorText.includes("expired") || errorText.includes("invalid")) {
        showStatus("This code has expired or is no longer valid. Ask your lecturer for the current code.", "error");
      } else if (errorText.includes("not enrolled")) {
        showStatus("You aren't enrolled in this course, so attendance wasn't recorded. Contact your administrator if this is a mistake.", "error");
      } else if (errorText.includes("already") || errorText.includes("duplicate")) {
        showStatus("Your attendance for this session has already been recorded.", "success");
      } else {
        showStatus("We couldn't record your attendance. Please try again or ask your lecturer for help.", "error");
      }
      scanAgainButton.hidden = false;
      return;
    }

    showStatus("Attendance recorded successfully. You're checked in!", "success");
    scanAgainButton.hidden = false;
  } catch {
    showStatus("We couldn't connect to record your attendance. Check your connection and try again.", "error");
    scanAgainButton.hidden = false;
  } finally {
    submitting = false;
  }
}

async function startScanner() {
  if (!window.Html5Qrcode) {
    showStatus("The scanner couldn't load. Check your connection and refresh this page.", "error");
    scanAgainButton.hidden = false;
    return;
  }

  scanAgainButton.hidden = true;
  showStatus("Requesting camera access…");
  try {
    if (!scanner) scanner = new window.Html5Qrcode(scannerElementId);
    await scanner.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: (viewWidth, viewHeight) => {
          const size = Math.floor(Math.min(viewWidth, viewHeight, 280) * 0.8);
          return { width: size, height: size };
        },
        aspectRatio: 1,
      },
      handleScan,
      () => {},
    );
    scannerRunning = true;
    showStatus("Camera ready. Point it at the lecturer’s TapMark code.");
  } catch (error) {
    const details = String(error?.message || error || "").toLowerCase();
    if (details.includes("permission") || details.includes("notallowed")) {
      showStatus("Camera access was blocked. Allow camera permission in your browser settings, then try again.", "error");
    } else if (details.includes("secure") || details.includes("origin")) {
      showStatus("Camera access requires HTTPS or localhost. Open TapMark over a secure connection.", "error");
    } else {
      showStatus("We couldn't open your camera. Check that no other app is using it, then try again.", "error");
    }
    scanAgainButton.hidden = false;
  }
}

async function initialize() {
  setupLogout(appRoot);
  const authorized = await guardPage("student", appRoot);
  if (!authorized) return;

  scanAgainButton.addEventListener("click", () => {
    if (!scannerRunning) void startScanner();
  });
  await startScanner();
}

void initialize();
