import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fetchOmHome } from "../../api";

export default function OM_HomePage() {
  const nav = useNavigate();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem("animo.user");
    if (!raw) { nav("/Login"); return; }
    const u = JSON.parse(raw);
    fetchOmHome(u.userId).then(setData).catch(e=>setErr(String(e)));
  }, [nav]);

  if (err) return <p style={{color:"crimson"}}>{err}</p>;
  if (!data) return <p>Loading…</p>;

  const c = data.cards;
  return (
    <div style={{padding:24}}>
      <h1>OM Home</h1>
      <div style={{display:"flex", gap:16}}>
        <Card title="My Notifications" value={c.notifications} />
        <Card title="My Roles" value={c.myRoles} />
        <Card title="Total Courses" value={c.totalCourses} />
        <Card title="Total Sections" value={c.totalSections} />
      </div>
      <div style={{marginTop:24}}>
        <Link to="/om/profile">Go to Profile →</Link>
      </div>
    </div>
  );
}
function Card({title, value}:{title:string; value:number}) {
  return (
    <div style={{border:"1px solid #ddd", borderRadius:8, padding:16, minWidth:180}}>
      <div style={{fontSize:14, color:"#555"}}>{title}</div>
      <div style={{fontSize:28, fontWeight:700}}>{value}</div>
    </div>
  );
}
