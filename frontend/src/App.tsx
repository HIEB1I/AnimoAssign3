import { BrowserRouter, Link, Route, Routes } from "react-router-dom";

import "./App.css";

const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export default function App() {
  return (
    <BrowserRouter basename={base}>
     
    </BrowserRouter>
  );
}
