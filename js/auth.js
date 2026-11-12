import { supabase } from "./supabase.js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";

const ROLES = new Set(["student", "lecturer", "admin"]);

function isConfigured() {
  return SUPABASE_URL.startsWith("https://")
    && !SUPABASE_URL.includes("YOUR-PROJECT")
    && Boolean(SUPABASE_ANON_KEY)
    && !SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");
}

function roleHome(role, appRoot) {
  if (!ROLES.has(role)) {
    throw new Error("Your account does not have a supported role. Please contact your administrator.");
  }
  if (role === "lecturer") {
    return `${appRoot}lecturer/dashboard.html`;
  }
  if (role === "student") {
    return `${appRoot}student/dashboard.html`;
  }
  if (role === "admin") {
    return `${appRoot}admin/dashboard.html`;
  }
  return `${appRoot}${role}/index.html`;
}

async function getRole(userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw new Error("We couldn't check your account access. Please try again.");
  }
  if (!data || !ROLES.has(data.role)) {
    throw new Error("Your account role isn't set up yet. Please contact your administrator.");
  }
  return data.role;
}

function setMessage(element, message, kind = "error") {
  if (!element) return;
  element.textContent = message;
  element.dataset.kind = message ? kind : "";
}

function friendlyAuthError(error, action) {
  const message = (error?.message || "").toLowerCase();
  if (message.includes("invalid login credentials")) {
    return "That email and password don't match. Check them and try again.";
  }
  if (message.includes("email not confirmed")) {
    return "Please confirm your email using the link we sent you, then sign in.";
  }
  if (message.includes("already registered") || message.includes("already been registered")) {
    return "An account with that email already exists. Try signing in instead.";
  }
  if (message.includes("password") && (message.includes("weak") || message.includes("short"))) {
    return "Choose a stronger password with at least 8 characters.";
  }
  if (message.includes("rate limit") || message.includes("too many requests")) {
    return "There have been too many attempts. Please wait a moment and try again.";
  }
  return action === "register"
    ? "We couldn't create your account right now. Please check your details and try again."
    : "We couldn't sign you in right now. Please try again in a moment.";
}

function setLoading(form, button, loading, label) {
  button.disabled = loading;
  button.setAttribute("aria-busy", String(loading));
  button.textContent = loading ? label : button.dataset.label;
  form.setAttribute("aria-busy", String(loading));
}

async function redirectForUser(user, appRoot) {
  const role = await getRole(user.id);
  window.location.replace(roleHome(role, appRoot));
}

async function initializeLoginForm(appRoot) {
  const form = document.querySelector("#login-form");
  if (!form) return;

  const button = form.querySelector('button[type="submit"]');
  const message = document.querySelector("#login-message");
  button.dataset.label = button.textContent;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage(message, "");
    if (!form.reportValidity()) return;

    setLoading(form, button, true, "Signing in…");
    try {
      const email = form.elements.email.value.trim();
      const password = form.elements.password.value;
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await redirectForUser(data.user, appRoot);
    } catch (error) {
      setMessage(message, error.message?.startsWith("Your account") || error.message?.startsWith("We couldn't check")
        ? error.message
        : friendlyAuthError(error, "login"));
    } finally {
      setLoading(form, button, false, "");
    }
  });
}

async function initializeRegisterForm(appRoot) {
  const form = document.querySelector("#register-form");
  if (!form) return;

  const button = form.querySelector('button[type="submit"]');
  const message = document.querySelector("#register-message");
  const password = form.elements.password;
  const confirmation = form.elements["password-confirm"];
  button.dataset.label = button.textContent;

  const validatePasswordMatch = () => {
    confirmation.setCustomValidity(
      confirmation.value && confirmation.value !== password.value ? "Passwords do not match." : "",
    );
  };
  confirmation.addEventListener("input", validatePasswordMatch);
  password.addEventListener("input", validatePasswordMatch);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage(message, "");
    validatePasswordMatch();
    if (!form.reportValidity()) return;

    setLoading(form, button, true, "Creating account…");
    try {
      const { data, error } = await supabase.auth.signUp({
        email: form.elements.email.value.trim(),
        password: password.value,
        options: {
          data: { full_name: form.elements.name.value.trim() },
        },
      });
      if (error) throw error;

      if (data.session && data.user) {
        await redirectForUser(data.user, appRoot);
      } else {
        form.reset();
        setMessage(
          message,
          "Your account is almost ready. Check your email for a confirmation link, then sign in.",
          "success",
        );
      }
    } catch (error) {
      setMessage(message, error.message?.startsWith("Your account") || error.message?.startsWith("We couldn't check")
        ? error.message
        : friendlyAuthError(error, "register"));
    } finally {
      setLoading(form, button, false, "");
    }
  });
}

export async function initializeAuthPage() {
  const appRoot = document.body.dataset.appRoot || "./";
  const forms = document.querySelector("#login-form, #register-form");
  if (!forms) return;

  if (!isConfigured()) {
    const message = document.querySelector("#login-message, #register-message");
    setMessage(message, "Sign-in is not available yet. Please ask your administrator to configure Supabase.");
    document.querySelectorAll(".auth-submit").forEach((button) => { button.disabled = true; });
    return;
  }

  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (data.session?.user) {
      await redirectForUser(data.session.user, appRoot);
      return;
    }
  } catch (error) {
    const message = error.message?.startsWith("Your account") || error.message?.startsWith("We couldn't check")
      ? error.message
      : "We couldn't connect to TapMark. Please refresh the page and try again.";
    setMessage(document.querySelector("#login-message, #register-message"), message);
  }

  await Promise.all([initializeLoginForm(appRoot), initializeRegisterForm(appRoot)]);
}

export async function guardPage(requiredRole, appRoot = "../") {
  const status = document.querySelector("#auth-status");
  const protectedContent = document.querySelector("[data-protected-content]");
  const logoutButton = document.querySelector("#logout-button");

  if (!ROLES.has(requiredRole)) {
    setMessage(status, "This page has an invalid access configuration.");
    return false;
  }
  if (!isConfigured()) {
    setMessage(status, "This page is unavailable until Supabase is configured.");
    return false;
  }

  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (!data.session?.user) {
      window.location.replace(`${appRoot}signin.html`);
      return false;
    }

    const actualRole = await getRole(data.session.user.id);
    if (actualRole !== requiredRole) {
      window.location.replace(roleHome(actualRole, appRoot));
      return false;
    }

    protectedContent.hidden = false;
    logoutButton.hidden = false;
    return true;
  } catch (error) {
    setMessage(status, error.message || "We couldn't verify your access. Please refresh and try again.");
    return false;
  }
}

export function setupLogout(appRoot = "../") {
  const button = document.querySelector("#logout-button");
  const status = document.querySelector("#auth-status");
  if (!button) return;

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    setMessage(status, "");
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      window.location.replace(`${appRoot}signin.html`);
    } catch {
      setMessage(status, "We couldn't sign you out. Please try again.");
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  });
}
