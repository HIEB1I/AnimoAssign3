import React, { useState } from "react";
import { Link } from "react-router-dom";
// import { fetchTeachingHistory } from "../../api";

export default function OM_PredPage1() {
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Descriptive Reports</h1>
        <Link to="/om/home">← Back to OM Home</Link>
      </div>


    </div>
  );
}