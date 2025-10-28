import { useEffect, useState } from "react";
import { fetchOmProfile } from "../../api";

export default function OM_ProfilePage() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem("animo.user");
    if (!raw) { setErr("Not signed in"); return; }
    const u = JSON.parse(raw);
    fetchOmProfile(u.userId).then(setData).catch(e => setErr(String(e)));
  }, []);

  if (err) return <p style={{color:"crimson"}}>{err}</p>;
  if (!data) return <p>Loading…</p>;

  const u = data.user || {};
  const staff = data.staffProfile || {};
  const deptNames = (data.departments||[]).map((d:any)=>d.department_name).join(", ") || "—";
  const roles = (data.roles||[]).map((r:any)=>r.role_type).join(", ") || "—";

  return (
    <div style={{padding:24}}>
      <h1>My Profile</h1>
      <table><tbody>
        <Row k="Name" v={`${u.first_name||""} ${u.last_name||""}`.trim() || "—"} />
        <Row k="Email" v={u.email || "—"} />
        <Row k="Status" v={String(u.status ?? "—")} />
        <Row k="Roles" v={roles} />
        <Row k="Departments" v={deptNames} />
        <Row k="Position" v={staff.position_title || "—"} />
        <Row k="Last Login" v={u.last_login || "—"} />
      </tbody></table>
    </div>
  );
}
function Row({k, v}:{k:string; v:any}) {
  return (
    <tr>
      <td style={{padding:"6px 12px", color:"#666"}}>{k}</td>
      <td style={{padding:"6px 12px"}}>{String(v)}</td>
    </tr>
  )
}
