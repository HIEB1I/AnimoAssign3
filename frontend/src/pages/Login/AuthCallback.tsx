import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { LoginResponse } from "@/api";


function b64urlToJson<T = unknown>(b64: string): T {
const pad = b64.length % 4 === 0 ? "" : "====".slice(b64.length % 4);
const s = b64.replace(/-/g, "+").replace(/_/g, "/") + pad;
const json = atob(s);
return JSON.parse(json) as T;
}


const AuthCallback: React.FC = () => {
const navigate = useNavigate();


useEffect(() => {
const params = new URLSearchParams(window.location.search);
const raw = params.get("u");


try {
if (!raw) throw new Error("Missing login payload");
const user = b64urlToJson<LoginResponse>(raw);
localStorage.setItem("animo.user", JSON.stringify(user));


const roles = (user.roles || []).map((r) => r.toLowerCase());
if (roles.includes("apo")) {
navigate("/apo/preenlistment", { replace: true });
} else if (roles.includes("office_manager")) {
navigate("/om/home", { replace: true });
} else if (roles.includes("faculty")) {
navigate("/faculty/overview", { replace: true });
} else if (roles.includes("student")) {
navigate("/student/petition", { replace: true });
} else if (roles.includes("dean")) {
navigate("/dean/dashboard", { replace: true });
} else {
navigate("/om/home", { replace: true });
}
} catch (e) {
console.error(e);
navigate("/login", { replace: true });
}
}, [navigate]);


return (
<div className="min-h-screen flex items-center justify-center">
<p className="text-gray-600">Finishing sign‑in…</p>
</div>
);
};


export default AuthCallback;