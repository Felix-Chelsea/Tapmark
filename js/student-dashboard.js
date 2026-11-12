import { guardPage, setupLogout } from "./auth.js";
import { supabase } from "./supabase.js";

const appRoot = document.body.dataset.appRoot || "../";
const notice = document.querySelector("#student-notice");
const courseList = document.querySelector("#student-course-list");
const historyList = document.querySelector("#history-list");

function showNotice(message) {
  notice.textContent = message;
  notice.dataset.kind = message ? "error" : "";
}

function addEmptyRow(message) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.className = "empty-state";
  cell.colSpan = 3;
  cell.textContent = message;
  row.append(cell);
  historyList.replaceChildren(row);
}

function renderCourses(courses, attendanceByCourse, sessionsByCourse, percentagesAvailable = true) {
  courseList.replaceChildren();
  if (courses.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No courses are enrolled to your account yet. Contact your administrator if this seems incorrect.";
    courseList.append(empty);
    return;
  }

  for (const course of courses) {
    const attended = attendanceByCourse.get(course.id) || 0;
    const total = sessionsByCourse.get(course.id) || 0;
    const percentage = percentagesAvailable && total > 0
      ? Math.min(100, Math.round((attended / total) * 100))
      : 0;

    const card = document.createElement("article");
    card.className = "student-course-card";
    const info = document.createElement("div");
    info.className = "student-course-info";
    const name = document.createElement("h3");
    const code = document.createElement("p");
    name.textContent = course.name;
    code.textContent = course.code;
    info.append(name, code);

    const progress = document.createElement("div");
    progress.className = "course-progress";
    const summary = document.createElement("div");
    summary.className = "course-progress-summary";
    const count = document.createElement("span");
    const rate = document.createElement("strong");
    count.textContent = percentagesAvailable
      ? `${attended} of ${total} completed sessions attended`
      : "Attendance rate is temporarily unavailable";
    rate.textContent = percentagesAvailable ? `${percentage}%` : "—";
    summary.append(count, rate);
    const meter = document.createElement("progress");
    meter.max = 100;
    meter.value = percentage;
    meter.setAttribute(
      "aria-label",
      percentagesAvailable ? `${course.name} attendance: ${percentage}%` : `${course.name} attendance rate unavailable`,
    );
    progress.append(summary, meter);
    card.append(info, progress);
    courseList.append(card);
  }
}

function renderHistory(records) {
  historyList.replaceChildren();
  if (records.length === 0) {
    addEmptyRow("No attendance has been recorded yet.");
    return;
  }

  for (const record of records) {
    const row = document.createElement("tr");
    const courseCell = document.createElement("td");
    const dateCell = document.createElement("td");
    const timeCell = document.createElement("td");
    const date = new Date(record.marked_at);
    courseCell.textContent = `${record.course_name} (${record.course_code})`;
    dateCell.textContent = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date);
    timeCell.textContent = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
    row.append(courseCell, dateCell, timeCell);
    historyList.append(row);
  }

  if (!historyList.children.length) addEmptyRow("No attendance has been recorded yet.");
}

async function loadDashboard(studentId) {
  const { data: enrollments, error: enrollmentError } = await supabase
    .from("course_enrollments")
    .select("course_id")
    .eq("student_id", studentId);

  if (enrollmentError) {
    showNotice("We couldn't load your enrolled courses. Please refresh the page.");
    courseList.replaceChildren();
    addEmptyRow("Attendance history is unavailable.");
    return;
  }

  const courseIds = [...new Set(enrollments.map((enrollment) => enrollment.course_id))];
  if (courseIds.length === 0) {
    renderCourses([], new Map(), new Map());
    addEmptyRow("No attendance has been recorded yet.");
    return;
  }

  const [{ data: courses, error: coursesError }, { data: sessions, error: sessionsError }, { data: attendance, error: attendanceError }] =
    await Promise.all([
      supabase.from("courses").select("id, name, code").in("id", courseIds).order("name"),
      supabase.from("sessions").select("id, course_id").in("course_id", courseIds)
        .lte("expires_at", new Date().toISOString()),
      supabase.rpc("get_my_attendance_history"),
    ]);

  if (coursesError) {
    showNotice("We couldn't load your courses. Please refresh the page.");
    courseList.replaceChildren();
    addEmptyRow("Attendance history is unavailable.");
    return;
  }

  const sessionsByCourse = new Map();
  const completedSessionIds = new Set();
  if (sessionsError) {
    showNotice("Your courses loaded, but attendance percentages couldn't be calculated.");
  } else {
    for (const session of sessions) {
      completedSessionIds.add(session.id);
      sessionsByCourse.set(session.course_id, (sessionsByCourse.get(session.course_id) || 0) + 1);
    }
  }

  const attendanceByCourse = new Map();
  if (attendanceError) {
    showNotice("Your courses loaded, but attendance history couldn't be refreshed.");
    addEmptyRow("We couldn't load your attendance history.");
  } else {
    for (const record of records) {
      if (completedSessionIds.has(record.session_id)) {
        attendanceByCourse.set(record.course_id, (attendanceByCourse.get(record.course_id) || 0) + 1);
      }
    }
    renderHistory(attendance);
  }

  renderCourses(courses, attendanceByCourse, sessionsByCourse, !sessionsError && !attendanceError);
}

async function initialize() {
  setupLogout(appRoot);
  const authorized = await guardPage("student", appRoot);
  if (!authorized) return;

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    showNotice("We couldn't verify your account. Please sign in again.");
    return;
  }
  await loadDashboard(data.user.id);
}

void initialize();
