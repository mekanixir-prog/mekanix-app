"use client";
import { useState, useEffect } from "react";

export default function AdminPanelPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin-panel/auth/me", { credentials: "same-origin", cache: "no-store" });
        if (!cancelled) setAuthenticated(res.ok);
      } catch {
        if (!cancelled) setAuthenticated(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div className="grid min-h-screen place-items-center bg-background"><div className="size-8 animate-spin rounded-full border-2 border-amber border-t-transparent" /></div>;
  }

  if (!authenticated) return <LoginScreen onLogin={() => setAuthenticated(true)} />;
  return <AdminDashboard onLogout={async () => {
    try {
      const res = await fetch("/api/admin-panel/auth/logout", { method: "POST", credentials: "same-origin" });
      if (!res.ok) throw new Error("خروج از پنل تأیید نشد");
      setAuthenticated(false);
    } catch {
      window.alert("ارتباط با سرور برقرار نشد؛ خروج انجام نشده است. دوباره تلاش کنید.");
    }
  }} />;
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [emailOrUsername, setEmailOrUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleLogin() {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/admin-panel/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailOrUsername, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onLogin();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-background p-4" dir="rtl">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 grid size-16 place-items-center rounded-2xl border border-amber/30 bg-amber/10">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#F5A524" strokeWidth="2"><path d="M12 2L2 7v10c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-10-5z"/><path d="M9 12l2 2 4-4"/></svg>
          </div>
          <h1 className="text-xl font-bold">MEKANIX ADMIN</h1>
          <p className="mt-1 text-sm text-muted-foreground">پنل مدیریت</p>
        </div>
        {error && <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">ایمیل یا نام کاربری</label>
            <input value={emailOrUsername} onChange={e => setEmailOrUsername(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()}
              className="w-full rounded-lg border border-border bg-card px-3 py-2.5 text-sm focus:border-amber focus:outline-none" dir="ltr" placeholder="admin" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">رمز عبور</label>
            <div className="relative">
              <input type={showPwd ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()}
                className="w-full rounded-lg border border-border bg-card px-3 py-2.5 pe-10 text-sm focus:border-amber focus:outline-none" dir="ltr" placeholder="••••••••" />
              <button onClick={() => setShowPwd(!showPwd)} className="absolute end-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{showPwd ? "👁" : "👁‍🗨"}</button>
            </div>
          </div>
        </div>
        <button onClick={handleLogin} disabled={busy || !emailOrUsername || !password}
          className="mt-4 w-full rounded-lg bg-amber px-4 py-2.5 font-medium text-black transition hover:bg-amber/90 disabled:opacity-50">
          {busy ? "..." : "ورود به پنل"}
        </button>
      </div>
    </div>
  );
}

function AdminDashboard({ onLogout }: { onLogout: () => void | Promise<void> }) {
  const [section, setSection] = useState("onboarding");
  const [slides, setSlides] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<any | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin-panel/onboarding", { credentials: "same-origin" });
        const data = await res.json();
        if (!cancelled) setSlides(data || []);
      } catch {}
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const loadSlides = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin-panel/onboarding", { credentials: "same-origin" });
      const data = await res.json();
      setSlides(data || []);
    } catch {}
    setLoading(false);
  };

  async function handleDelete(id: string) {
    if (!confirm("حذف شود؟")) return;
    await fetch(`/api/admin-panel/onboarding/${id}`, { method: "DELETE", credentials: "same-origin" });
    loadSlides();
  }

  async function handleToggleActive(slide: any) {
    await fetch(`/api/admin-panel/onboarding/${slide.id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !slide.active }),
    });
    loadSlides();
  }

  return (
    <div className="flex min-h-screen bg-background" dir="rtl">
      {/* Sidebar */}
      <aside className="w-60 border-l border-border bg-card/30 p-3">
        <div className="mb-4 flex items-center justify-between">
          <span className="font-bold text-amber">MEKANIX</span>
          <button onClick={onLogout} className="text-xs text-muted-foreground hover:text-foreground">خروج</button>
        </div>
        <nav className="space-y-1">
          {[
            { id: "onboarding", label: "آنبوردینگ" },
            { id: "dashboard", label: "داشبورد" },
          ].map(item => (
            <button key={item.id} onClick={() => setSection(item.id)}
              className={`w-full rounded-lg px-3 py-2 text-sm font-medium transition ${section === item.id ? "bg-amber/15 text-amber" : "text-muted-foreground hover:bg-accent"}`}>
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <main className="flex-1 p-6">
        {section === "onboarding" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold">مدیریت آنبوردینگ</h1>
                <p className="mt-1 text-sm text-muted-foreground">ویرایش متن و تصاویر صفحات معرفی</p>
              </div>
              <button onClick={() => setEditing({})} className="flex items-center gap-2 rounded-lg bg-amber px-4 py-2 text-sm font-medium text-black hover:bg-amber/90">اسلاید جدید</button>
            </div>
            {loading ? (
              <div className="grid h-64 place-items-center"><div className="size-8 animate-spin rounded-full border-2 border-amber border-t-transparent" /></div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {slides.map(slide => (
                  <div key={slide.id} className={`overflow-hidden rounded-xl border bg-card ${slide.active ? "border-border" : "border-border opacity-60"}`}>
                    <div className="relative aspect-[9/16] max-h-48 overflow-hidden bg-muted">
                      <img src={slide.image} alt={slide.titleFa} className="size-full object-cover" />
                      <div className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold text-amber">#{slide.order}</div>
                      {!slide.active && <div className="absolute inset-0 grid place-items-center bg-black/60"><span className="rounded-full bg-red-500/20 px-3 py-1 text-xs font-bold text-red-400">غیرفعال</span></div>}
                    </div>
                    <div className="p-4">
                      <h3 className="font-bold text-sm line-clamp-1">{slide.titleFa}</h3>
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{slide.subtitleFa}</p>
                      <div className="mt-3 flex gap-2">
                        <button onClick={() => setEditing(slide)} className="flex-1 rounded-lg border border-border bg-background/50 px-3 py-1.5 text-xs font-medium hover:border-amber/50 hover:text-amber">ویرایش</button>
                        <button onClick={() => handleToggleActive(slide)} className="rounded-lg border border-border px-3 py-1.5 text-xs">{slide.active ? "غیرفعال" : "فعال"}</button>
                        <button onClick={() => handleDelete(slide.id)} className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/20">حذف</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {editing && (
          <EditModal slide={editing} onClose={() => { setEditing(null); loadSlides(); }} />
        )}
      </main>
    </div>
  );
}

function EditModal({ slide, onClose }: { slide: any; onClose: () => void }) {
  const isEdit = slide.id;
  const [form, setForm] = useState({
    titleFa: slide.titleFa || "", subtitleFa: slide.subtitleFa || "", tagFa: slide.tagFa || "",
    bulletsFa: slide.bulletsFa ? JSON.parse(slide.bulletsFa).join("\n") : "",
    titleEn: slide.titleEn || "", subtitleEn: slide.subtitleEn || "", tagEn: slide.tagEn || "",
    bulletsEn: slide.bulletsEn ? JSON.parse(slide.bulletsEn).join("\n") : "",
    accent: slide.accent || "amber", order: slide.order || 1, active: slide.active ?? true,
    imageBase64: "", image: slide.image || "",
  });
  const [saving, setSaving] = useState(false);

  function handleImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setForm({ ...form, imageBase64: reader.result as string });
    reader.readAsDataURL(file);
  }

  async function handleSave() {
    if (!form.titleFa || !form.subtitleFa) { alert("عنوان و زیرعنوان الزامی است"); return; }
    setSaving(true);
    try {
      const payload = { ...form, bulletsFa: JSON.stringify(form.bulletsFa.split("\n").filter(Boolean)), bulletsEn: JSON.stringify(form.bulletsEn.split("\n").filter(Boolean)) };
      const url = isEdit ? `/api/admin-panel/onboarding/${slide.id}` : "/api/admin-panel/onboarding";
      await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      onClose();
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-6" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{isEdit ? "ویرایش اسلاید" : "اسلاید جدید"}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-accent hover:text-foreground">✕</button>
        </div>
        <div className="space-y-4">
          {/* Image upload */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">تصویر اسلاید</label>
            <div className="flex items-center gap-3">
              <div className="size-20 overflow-hidden rounded-lg border border-border bg-muted">
                {form.imageBase64 ? <img src={form.imageBase64} alt="" className="size-full object-cover" /> : form.image ? <img src={form.image} alt="" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-muted-foreground">📤</div>}
              </div>
              <label className="cursor-pointer rounded-lg border border-border bg-background/50 px-3 py-2 text-xs font-medium hover:border-amber/50">انتخاب تصویر<input type="file" accept="image/*" className="hidden" onChange={handleImage} /></label>
            </div>
          </div>
          {/* Persian fields */}
          <div className="rounded-lg border border-border p-4">
            <h3 className="mb-3 text-sm font-bold text-amber">متن فارسی</h3>
            <div className="space-y-3">
              <input value={form.titleFa} onChange={e => setForm({ ...form, titleFa: e.target.value })} placeholder="عنوان" className="w-full rounded-lg border border-border bg-background/50 px-3 py-2 text-sm focus:border-amber focus:outline-none" />
              <textarea value={form.subtitleFa} onChange={e => setForm({ ...form, subtitleFa: e.target.value })} placeholder="زیرعنوان" rows={3} className="w-full rounded-lg border border-border bg-background/50 px-3 py-2 text-sm focus:border-amber focus:outline-none" />
              <div className="grid grid-cols-2 gap-3">
                <input value={form.tagFa} onChange={e => setForm({ ...form, tagFa: e.target.value })} placeholder="تگ" className="rounded-lg border border-border bg-background/50 px-3 py-2 text-sm focus:border-amber focus:outline-none" />
                <select value={form.accent} onChange={e => setForm({ ...form, accent: e.target.value })} className="rounded-lg border border-border bg-background/50 px-3 py-2 text-sm focus:border-amber focus:outline-none"><option value="amber">کهربایی</option><option value="emerald">سبز</option></select>
              </div>
              <textarea value={form.bulletsFa} onChange={e => setForm({ ...form, bulletsFa: e.target.value })} placeholder="نکات (هر خط یک نکته)" rows={3} className="w-full rounded-lg border border-border bg-background/50 px-3 py-2 text-sm focus:border-amber focus:outline-none" />
            </div>
          </div>
          {/* English fields */}
          <div className="rounded-lg border border-border p-4">
            <h3 className="mb-3 text-sm font-bold text-sky-400">English Text</h3>
            <div className="space-y-3">
              <input value={form.titleEn} onChange={e => setForm({ ...form, titleEn: e.target.value })} placeholder="Title" dir="ltr" className="w-full rounded-lg border border-border bg-background/50 px-3 py-2 text-sm focus:border-amber focus:outline-none" />
              <textarea value={form.subtitleEn} onChange={e => setForm({ ...form, subtitleEn: e.target.value })} placeholder="Subtitle" rows={3} dir="ltr" className="w-full rounded-lg border border-border bg-background/50 px-3 py-2 text-sm focus:border-amber focus:outline-none" />
              <input value={form.tagEn} onChange={e => setForm({ ...form, tagEn: e.target.value })} placeholder="Tag" dir="ltr" className="w-full rounded-lg border border-border bg-background/50 px-3 py-2 text-sm focus:border-amber focus:outline-none" />
              <textarea value={form.bulletsEn} onChange={e => setForm({ ...form, bulletsEn: e.target.value })} placeholder="Bullets (one per line)" rows={3} dir="ltr" className="w-full rounded-lg border border-border bg-background/50 px-3 py-2 text-sm focus:border-amber focus:outline-none" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} className="size-4 accent-amber" />فعال</label>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-accent">انصراف</button>
          <button onClick={handleSave} disabled={saving} className="rounded-lg bg-amber px-4 py-2 text-sm font-medium text-black hover:bg-amber/90 disabled:opacity-50">{saving ? "..." : "ذخیره"}</button>
        </div>
      </div>
    </div>
  );
}
