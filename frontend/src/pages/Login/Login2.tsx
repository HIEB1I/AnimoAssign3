import React from "react";
import { useNavigate } from "react-router-dom";
import AA_Logo from "@/assets/Images/AA_Logo.png"; // use your existing brand mark
import { API_BASE } from "@/api";


function join(a: string, b: string) {
return `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}


const Login: React.FC = () => {
const onGoogle = () => {
const returnTo = `${window.location.origin}/auth/callback`;
const url = join(API_BASE, `auth/google/start?return_to=${encodeURIComponent(returnTo)}`);
window.location.href = url; // full redirect to Google
};


return (
<div className="min-h-screen w-full grid grid-cols-1 md:grid-cols-2 bg-white">
{/* Left pane: copy + CTA */}
<div className="flex items-center justify-center p-8 md:p-12">
<div className="max-w-md w-full">
<h1 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-4">
Log in or sign up now!
</h1>
<p className="text-lg text-gray-700 mb-8">
Use your DLSU email address to continue with
<span className="font-semibold"> AnimoAssign</span>!
</p>


<button
onClick={onGoogle}
className="w-full rounded-xl border border-gray-300 px-6 py-4 text-lg font-semibold shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-300"
>
Login with your DLSU Google Account
</button>


<p className="mt-6 text-sm text-gray-600">
By using ArcherEye, you agree to follow the guidelines outlined in the
<a href="#" className="underline ml-1">DLSU Student Handbook</a>
<span> and </span>
<a href="/privacy" className="underline">Privacy Policy</a>
<span> of AnimoAssign.</span>
</p>
</div>
</div>


{/* Right pane: green welcome panel */}
<div className="hidden md:flex items-center justify-center p-8 bg-gradient-to-br from-emerald-700 via-emerald-600 to-emerald-500">
<div className="text-center text-white">
<p className="text-xl opacity-90 mb-2">Welcome to</p>
<img src={AA_Logo} alt="AnimoAssign" className="mx-auto w-[320px] h-auto" />
<p className="mt-3 opacity-90">AnimoAssign is a collaborative platform for</p>
</div>
</div>
</div>
);
};


export default Login;