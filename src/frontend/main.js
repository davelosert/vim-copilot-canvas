import { mountApp } from "./app.js";

const app = mountApp();
app.ready.catch(() => {});
