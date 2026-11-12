import { guardPage, setupLogout } from "./auth.js";
import { supabase } from "./supabase.js";

const appRoot = document.body.dataset.appRoot || "../";
const courseList = document.querySelector("#course-list");
const courseForm = document.querySelector("#course-form");
const courseButton = document.querySelector("#create-course-button");
const courseMessage = document.querySelector("#course-message");
const dashboardNotice = document.querySelector("#dashboard-notice");
const sessionPanel = document.querySelector("#session-panel");
const sessionCourseName = document.querySelector("#session-course-name");
const sessionQr = document.querySelector("#session-qr");
const sessionCountdown = document.querySelector("#session-countdown");
const sessionState = document.querySelector("#session-state");
const sessionHelper = document.querySelector("#session-helper");
const newSessionButton = document.querySelector("#new-session-button");
const attendanceList = document.querySelector("#attendance-list");
const attendanceCount = document.querySelector("#attendance-count");

let lecturerId = null;
let courses = [];
let currentSession = null;
let countdownInterval = null;
let attendanceChannel = null;
let creatingSession = false;

function showMessage(element, message, kind = "error") {
  element.textContent = message;
  element.dataset.kind = message ? kind : "";
}

function setFormLoading(loading) {
  courseButton.disabled = loading;
  courseButton.setAttribute("aria-busy", String(loading));
  courseButton.textContent = loading ? "Adding course…" : "Add course";
}

function stopSessionListeners() {
  if (countdownInterval !== null) {
    window.clearInterval(countdownInterval);
    countdownInterval = null;
  }
  if (attendanceChannel) {
    void supabase.removeChannel(attendanceChannel);
    attendanceChannel = null;
  }
}

function updateCountdown() {
  if (!currentSession) return;
  const remaining = Math.max(0, Math.ceil((Date.parse(currentSession.expires_at) - Date.now()) / 1000));
  const minutes = Math.floor(remaining / 60).toString().padStart(2, "0");
  const seconds = (remaining % 60).toString().padStart(2, "0");
  sessionCountdown.textContent = remaining > 0 ? `Expires in ${minutes}:${seconds}` : "This code has expired.";

  if (remaining === 0) {
    stopSessionListeners();
    sessionState.textContent = "Expired";
    sessionState.dataset.state = "expired";
    sessionQr.hidden = true;
    sessionHelper.textContent = "This code can no longer be used to check in.";
    newSessionButton.hidden = false;
    renderCourses();
  }
}

async function loadAttendance(sessionId) {
  const { data: records, error } = await supabase
    .from("attendance")
    .select("id, student_id, marked_at")
    .eq("session_id", sessionId)
    .order("marked_at", { ascending: true });

  if (currentSession?.id !== sessionId) return;
  if (error) {
    showMessage(dashboardNotice, "We couldn't refresh the attendance list. Please try again.");
    return;
  }

  const studentIds = [...new Set(records.map((record) => record.student_id))];
  let namesById = new Map();
  if (studentIds.length > 0) {
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", studentIds);

    if (currentSession?.id !== sessionId) return;
    if (profilesError) {
      showMessage(dashboardNotice, "Attendance is up to date, but student names couldn't be loaded.");
      return;
    }
    namesById = new Map(profiles.map((profile) => [profile.id, profile.full_name]));
  }

  attendanceCount.textContent = String(records.length);
  attendanceList.replaceChildren();
  if (records.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "No students have checked in yet.";
    attendanceList.append(empty);
    return;
  }

  for (const record of records) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const time = document.createElement("time");
    name.textContent = namesById.get(record.student_id) || "Student";
    time.dateTime = record.marked_at;
    time.textContent = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(record.marked_at));
    item.append(name, time);
    attendanceList.append(item);
  }
}

function watchAttendance(sessionId) {
  attendanceChannel = supabase
    .channel(`attendance-${sessionId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "attendance",
        filter: `session_id=eq.${sessionId}`,
      },
      () => {
        void loadAttendance(sessionId);
      },
    )
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        showMessage(dashboardNotice, "Live attendance updates disconnected. Refresh the page to reconnect.");
      }
    });
}

async function showSession(course, session) {
  stopSessionListeners();
  currentSession = session;
  sessionCourseName.textContent = `${course.name} · ${course.code}`;
  sessionPanel.hidden = false;
  sessionQr.hidden = false;
  sessionQr.removeAttribute("hidden");
  sessionState.textContent = "Active";
  sessionState.dataset.state = "active";
  newSessionButton.hidden = true;
  sessionHelper.textContent = "Students can scan this code to mark attendance.";
  showMessage(dashboardNotice, "");

  if (!window.QRCode?.toCanvas) {
    showMessage(dashboardNotice, "The QR code could not be displayed. Check your connection and refresh.");
    return;
  }

  try {
    await window.QRCode.toCanvas(sessionQr, session.qr_token, {
      width: 240,
      margin: 2,
      color: { dark: "#172235", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
  } catch {
    showMessage(dashboardNotice, "The QR code could not be displayed. Please try opening the session again.");
    return;
  }

  updateCountdown();
  if (Date.parse(session.expires_at) > Date.now()) {
    countdownInterval = window.setInterval(updateCountdown, 1000);
    watchAttendance(session.id);
  }
  await loadAttendance(session.id);
}

async function createSession(course) {
  if (creatingSession) return;
  creatingSession = true;
  const button = [...courseList.querySelectorAll("[data-start-session]")]
    .find((item) => item.dataset.startSession === course.id);
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Creating code…";
  }
  showMessage(dashboardNotice, "");

  try {
    const { data, error } = await supabase.rpc("start_attendance_session", {
      course_id: course.id,
    });

    if (error) throw error;
    const session = Array.isArray(data) ? data[0] : data;
    if (!session) throw new Error("Session was not created.");
    course.latestSession = session;
    renderCourses();
    await showSession(course, session);
  } catch {
    showMessage(dashboardNotice, "We couldn't start the session. Please try again.");
  } finally {
    creatingSession = false;
    renderCourses();
  }
}

function renderCourses() {
  courseList.replaceChildren();
  if (courses.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No courses yet. Add your first course above to get started.";
    courseList.append(empty);
    return;
  }

  for (const course of courses) {
    const card = document.createElement("article");
    card.className = "course-card";
    const details = document.createElement("div");
    details.className = "course-details";
    const name = document.createElement("h2");
    const code = document.createElement("p");
    name.textContent = course.name;
    code.textContent = course.code;
    details.append(name, code);

    const button = document.createElement("button");
    button.className = "button button-small";
    button.type = "button";
    button.dataset.startSession = course.id;
    const active = course.latestSession && Date.parse(course.latestSession.expires_at) > Date.now();
    button.textContent = active ? "View active code" : "Start session";
    button.disabled = creatingSession;
    button.addEventListener("click", () => {
      if (active) {
        void showSession(course, course.latestSession);
      } else {
        void createSession(course);
      }
    });
    card.append(details, button);
    courseList.append(card);
  }
}

async function loadCourses() {
  const { data: courseData, error } = await supabase
    .from("courses")
    .select("id, name, code, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    showMessage(dashboardNotice, "We couldn't load your courses. Please refresh the page.");
    courseList.replaceChildren();
    return;
  }

  courses = courseData.map((course) => ({ ...course, latestSession: null }));
  if (courses.length > 0) {
    const { data: sessions, error: sessionsError } = await supabase
      .from("sessions")
      .select("id, course_id, qr_token, expires_at, created_at")
      .in("course_id", courses.map((course) => course.id))
      .order("created_at", { ascending: false });

    if (sessionsError) {
      showMessage(dashboardNotice, "Your courses loaded, but session details couldn't be refreshed.");
    } else {
      const latestByCourse = new Map();
      for (const session of sessions) {
        if (!latestByCourse.has(session.course_id)) latestByCourse.set(session.course_id, session);
      }
      for (const course of courses) {
        course.latestSession = latestByCourse.get(course.id) || null;
      }
    }
  }
  renderCourses();

  const activeCourse = courses.find((course) =>
    course.latestSession && Date.parse(course.latestSession.expires_at) > Date.now(),
  );
  if (activeCourse) {
    await showSession(activeCourse, activeCourse.latestSession);
  }
}

function setupCourseForm() {
  courseForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage(courseMessage, "");
    if (!courseForm.reportValidity()) return;

    setFormLoading(true);
    try {
      const { error } = await supabase.from("courses").insert({
        lecturer_id: lecturerId,
        name: courseForm.elements.name.value.trim(),
        code: courseForm.elements.code.value.trim().toUpperCase(),
      });
      if (error) throw error;
      courseForm.reset();
      showMessage(courseMessage, "Course added.", "success");
      await loadCourses();
    } catch {
      showMessage(courseMessage, "We couldn't add that course. Please check the details and try again.");
    } finally {
      setFormLoading(false);
    }
  });
}

async function initialize() {
  setupLogout(appRoot);
  const authorized = await guardPage("lecturer", appRoot);
  if (!authorized) return;

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    showMessage(dashboardNotice, "We couldn't verify your account. Please sign in again.");
    return;
  }
  lecturerId = data.user.id;
  setupCourseForm();
  newSessionButton.addEventListener("click", () => {
    const course = courses.find((item) => item.id === currentSession?.course_id);
    if (course) void createSession(course);
  });
  await loadCourses();
}

void initialize();
