import { guardPage, setupLogout } from "./auth.js";

const appRoot = document.body.dataset.appRoot || "../";
const requiredRole = document.body.dataset.requiredRole;

setupLogout(appRoot);
guardPage(requiredRole, appRoot);
