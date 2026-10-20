import { mountApp } from "./app.js";
import "./primer.css";

const app = mountApp();
app.ready.catch(() => {});
