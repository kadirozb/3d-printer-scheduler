import { useState, useMemo, useEffect, useCallback } from 'react';
import { supabase } from './supabaseClient';

const COLORS = [
  '#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FECA57',
  '#FF9FF3','#54A0FF','#5F27CD','#00D2D3','#FF9F43',
  '#C44569','#574B90','#3DC1D3','#F8B739','#2ECC71',
];

function getTeamColor(teamName, allTeams) {
  const idx = allTeams.indexOf(teamName);
  return COLORS[Math.abs(idx) % COLORS.length];
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

function minutesToTime(m) {
  const h = Math.floor(m / 60) % 24;
  const min = m % 60;
  return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}

function findConflict(appointments, newApp, excludeId = null) {
  const newStart = timeToMinutes(newApp.startTime);
  const dur = parseFloat(newApp.duration);
  if (isNaN(dur) || dur <= 0) return null;
  const newEnd = newStart + Math.round(dur * 60);
  for (const a of appointments) {
    if (a.id === excludeId) continue;
    if (a.date !== newApp.date) continue;
    const aStart = timeToMinutes(a.start_time);
    const aEnd = aStart + Math.round(parseFloat(a.duration) * 60);
    if (newStart < aEnd && newEnd > aStart) return a;
  }
  return null;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

const todayStr = (() => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
})();

export default function App() {
  const [view, setView] = useState('calendar');
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ team: '', date: todayStr, startTime: '09:00', duration: '1' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [toast, setToast] = useState(null);

  // Load appointments from Supabase
  const loadAppointments = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('appointments')
        .select('*')
        .order('date', { ascending: true });
      if (error) throw error;
      setAppointments(data || []);
    } catch (e) {
      showToast('Veri yüklenemedi: ' + e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAppointments();

    // Realtime subscription — tüm kullanıcılar anlık güncelleme görür
    const channel = supabase
      .channel('appointments-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments' }, () => {
        loadAppointments();
      })
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [loadAppointments]);

  function showToast(msg, type = 'success') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  // Normalize: Supabase'de start_time olarak saklanıyor
  const teamsForColor = useMemo(() => [...new Set(appointments.map(a => a.team))], [appointments]);

  function openAdd() {
    setForm({ team: '', date: selectedDate, startTime: '09:00', duration: '1' });
    setError('');
    setModal({ mode: 'add' });
  }

  function openEdit(app) {
    setForm({ team: app.team, date: app.date, startTime: app.start_time, duration: String(app.duration) });
    setError('');
    setModal({ mode: 'edit', app });
  }

  async function handleSave() {
    if (!form.team.trim()) { setError('Takım adı boş olamaz.'); return; }
    if (!form.date) { setError('Tarih seçiniz.'); return; }
    const dur = parseFloat(form.duration);
    if (isNaN(dur) || dur <= 0 || dur > 24) { setError('Süre 0.5 ile 24 saat arasında olmalı.'); return; }

    setSaving(true);
    try {
      // Çakışma kontrolü için Supabase'den güncel veriyi çek
      const { data: freshData, error: fetchError } = await supabase
        .from('appointments')
        .select('*');
      if (fetchError) throw fetchError;

      const excludeId = modal.mode === 'edit' ? modal.app.id : null;
      const normalizedApps = (freshData || []).map(a => ({ ...a, startTime: a.start_time }));
      const conflict = findConflict(normalizedApps, { ...form, duration: dur }, excludeId);

      if (conflict) {
        const conflictEnd = minutesToTime(timeToMinutes(conflict.start_time) + Math.round(conflict.duration * 60));
        setError(`⚠️ Çakışma!\n"${conflict.team}" takımı ${conflict.start_time}–${conflictEnd} saatleri arasında yazıcıyı kullanıyor.`);
        setSaving(false);
        return;
      }

      if (modal.mode === 'add') {
        const { error } = await supabase.from('appointments').insert({
          team: form.team.trim(),
          date: form.date,
          start_time: form.startTime,
          duration: dur,
        });
        if (error) throw error;
        showToast('✅ Randevu eklendi!');
      } else {
        const { error } = await supabase.from('appointments').update({
          team: form.team.trim(),
          date: form.date,
          start_time: form.startTime,
          duration: dur,
        }).eq('id', modal.app.id);
        if (error) throw error;
        showToast('✏️ Randevu güncellendi.');
      }
      setModal(null);
      // Kayıt sonrası listeyi hemen güncelle
      await loadAppointments();
    } catch (e) {
      setError('Kayıt hatası: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    setSaving(true);
    try {
      const { error } = await supabase.from('appointments').delete().eq('id', id);
      if (error) throw error;
      setModal(null);
      showToast('🗑️ Randevu silindi.', 'warning');
      await loadAppointments();
    } catch (e) {
      setError('Silme hatası: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  const daysInMonth = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysCount = new Date(year, month + 1, 0).getDate();
    const days = [];
    for (let i = 0; i < (firstDay === 0 ? 6 : firstDay - 1); i++) days.push(null);
    for (let d = 1; d <= daysCount; d++) {
      const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      days.push({ d, dateStr });
    }
    return days;
  }, [calendarMonth]);

  const appsForDay = (dateStr) => appointments.filter(a => a.date === dateStr);
  const dayApps = appointments
    .filter(a => a.date === selectedDate)
    .sort((a,b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));

  if (loading) return (
    <div style={{ minHeight:'100vh', background:'#0D0D12', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16 }}>
      <div style={{ fontSize:36, animation:'spin 1.5s linear infinite' }}>⬡</div>
      <div style={{ color:'#00D2D3', fontFamily:'monospace', letterSpacing:3, fontSize:12 }}>YÜKLENIYOR...</div>
      <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
    </div>
  );

  return (
    <div style={{ minHeight:'100vh', background:'#0D0D12', color:'#E8E8F0', fontFamily:"'Courier New','Lucida Console',monospace" }}>

      <style>{`
        @keyframes fadeSlide { from{opacity:0;transform:translateY(-10px)} to{opacity:1;transform:translateY(0)} }
        @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        input[type="date"]::-webkit-calendar-picker-indicator,
        input[type="time"]::-webkit-calendar-picker-indicator { filter:invert(0.4); cursor:pointer; }
        input:focus { border-color:#00D2D3 !important; box-shadow:0 0 0 2px rgba(0,210,211,0.1); }
        ::-webkit-scrollbar { width:4px; }
        ::-webkit-scrollbar-thumb { background:#2A2A4A; border-radius:4px; }
        .app-card:hover { border-color:#2A2A5A !important; }
        .timeline-item:hover { background:rgba(255,255,255,0.04) !important; }
      `}</style>

      {/* Toast */}
      {toast && (
        <div style={{
          position:'fixed', top:20, right:20, zIndex:9999,
          background: toast.type==='warning' ? '#1A1008' : toast.type==='error' ? '#1A0808' : '#081818',
          border:`1px solid ${toast.type==='warning' ? '#FF9F43' : toast.type==='error' ? '#FF6B6B' : '#00D2D3'}`,
          borderRadius:10, padding:'12px 20px', fontSize:12,
          color: toast.type==='warning' ? '#FF9F43' : toast.type==='error' ? '#FF6B6B' : '#00D2D3',
          boxShadow:'0 8px 32px rgba(0,0,0,0.7)',
          animation:'fadeSlide 0.25s ease', letterSpacing:1, maxWidth:300
        }}>{toast.msg}</div>
      )}

      {/* Realtime indicator */}
      <div style={{
        position:'fixed', bottom:16, right:16, zIndex:100,
        display:'flex', alignItems:'center', gap:7,
        background:'rgba(10,10,20,0.85)', border:'1px solid #1A1A3A',
        borderRadius:20, padding:'6px 12px', fontSize:10, color:'#3A5A3A', letterSpacing:1
      }}>
        <div style={{ width:6, height:6, borderRadius:'50%', background:'#2ECC71', boxShadow:'0 0 6px #2ECC71' }}/>
        CANLI
      </div>

      {/* Header */}
      <div style={{ background:'linear-gradient(135deg,#1A1A2E,#16213E,#0F3460)', borderBottom:'1px solid #2A2A4A', padding:'0 24px' }}>
        <div style={{ maxWidth:1140, margin:'0 auto', display:'flex', alignItems:'center', justifyContent:'space-between', padding:'16px 0', flexWrap:'wrap', gap:12 }}>
          <div style={{ display:'flex', alignItems:'center', gap:14 }}>
            <div style={{ width:44, height:44, background:'linear-gradient(135deg,#00D2D3,#54A0FF)', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, boxShadow:'0 0 20px rgba(0,210,211,0.4)' }}>⬡</div>
            <div>
              <div style={{ fontSize:17, fontWeight:'bold', letterSpacing:3, color:'#00D2D3' }}>3D PRİNTER</div>
              <div style={{ fontSize:10, color:'#5A5A7A', letterSpacing:3 }}>RANDEVU TAKİP SİSTEMİ</div>
            </div>
          </div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            {['calendar','list'].map(v => (
              <button key={v} onClick={() => setView(v)} style={{
                padding:'7px 16px', borderRadius:6, border:'1px solid',
                borderColor: view===v ? '#00D2D3' : '#2A2A4A',
                background: view===v ? 'rgba(0,210,211,0.1)' : 'transparent',
                color: view===v ? '#00D2D3' : '#5A5A7A',
                cursor:'pointer', fontSize:11, letterSpacing:1, fontFamily:'inherit'
              }}>{v==='calendar' ? '📅 TAKVİM' : '📋 LİSTE'}</button>
            ))}
            <button onClick={openAdd} style={{
              padding:'7px 18px', borderRadius:6, border:'none',
              background:'linear-gradient(135deg,#00D2D3,#54A0FF)',
              color:'#0D0D12', cursor:'pointer', fontSize:11,
              fontWeight:'bold', letterSpacing:1, fontFamily:'inherit',
              boxShadow:'0 0 14px rgba(0,210,211,0.35)'
            }}>+ RANDEVU EKLE</button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth:1140, margin:'0 auto', padding:'22px 24px' }}>

        {/* CALENDAR VIEW */}
        {view==='calendar' && (
          <div style={{ display:'grid', gridTemplateColumns:'290px 1fr', gap:20 }}>
            {/* Left panel */}
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

              {/* Mini calendar */}
              <div style={{ background:'#1A1A2E', border:'1px solid #2A2A4A', borderRadius:14, padding:16 }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
                  <button onClick={() => setCalendarMonth(m => new Date(m.getFullYear(),m.getMonth()-1,1))} style={navBtn}>‹</button>
                  <span style={{ fontWeight:'bold', letterSpacing:2, color:'#00D2D3', fontSize:11 }}>
                    {calendarMonth.toLocaleDateString('tr-TR',{month:'long',year:'numeric'}).toUpperCase()}
                  </span>
                  <button onClick={() => setCalendarMonth(m => new Date(m.getFullYear(),m.getMonth()+1,1))} style={navBtn}>›</button>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:2, marginBottom:5 }}>
                  {['Pt','Sa','Ça','Pe','Cu','Ct','Pz'].map(d => (
                    <div key={d} style={{ textAlign:'center', fontSize:9, color:'#3A3A5A', padding:'2px 0' }}>{d}</div>
                  ))}
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:2 }}>
                  {daysInMonth.map((day,i) => {
                    if (!day) return <div key={i}/>;
                    const isSelected = day.dateStr===selectedDate;
                    const isToday = day.dateStr===todayStr;
                    const dayList = appsForDay(day.dateStr);
                    return (
                      <button key={i} onClick={() => setSelectedDate(day.dateStr)} style={{
                        aspectRatio:'1', borderRadius:6, border:'1px solid',
                        borderColor: isSelected ? '#00D2D3' : dayList.length>0 ? '#252545' : 'transparent',
                        background: isSelected ? 'rgba(0,210,211,0.15)' : 'transparent',
                        color: isSelected ? '#00D2D3' : isToday ? '#FECA57' : '#B0B0C8',
                        cursor:'pointer', fontSize:10, fontFamily:'inherit',
                        display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:1,
                        fontWeight: isToday ? 'bold' : 'normal'
                      }}>
                        {day.d}
                        {dayList.length>0 && (
                          <div style={{ display:'flex', gap:1 }}>
                            {dayList.slice(0,3).map((a,idx) => (
                              <div key={idx} style={{ width:3, height:3, borderRadius:'50%', background:getTeamColor(a.team,teamsForColor) }}/>
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Teams */}
              {teamsForColor.length>0 && (
                <div style={{ background:'#1A1A2E', border:'1px solid #2A2A4A', borderRadius:14, padding:14 }}>
                  <div style={{ fontSize:9, color:'#3A3A5A', letterSpacing:2, marginBottom:10 }}>TAKIMLAR ({teamsForColor.length})</div>
                  {teamsForColor.map(t => (
                    <div key={t} style={{ display:'flex', alignItems:'center', gap:9, marginBottom:7 }}>
                      <div style={{ width:8, height:8, borderRadius:2, background:getTeamColor(t,teamsForColor), flexShrink:0 }}/>
                      <span style={{ fontSize:11, color:'#C0C0D8', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Stats */}
              <div style={{ background:'#1A1A2E', border:'1px solid #2A2A4A', borderRadius:14, padding:14 }}>
                <div style={{ fontSize:9, color:'#3A3A5A', letterSpacing:2, marginBottom:10 }}>İSTATİSTİK</div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                  {[
                    {label:'Toplam', value:appointments.length},
                    {label:'Bugün', value:appsForDay(todayStr).length},
                    {label:'Takım', value:teamsForColor.length},
                    {label:'Bu Ay', value:appointments.filter(a=>a.date.startsWith(`${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth()+1).padStart(2,'0')}`)).length},
                  ].map(s => (
                    <div key={s.label} style={{ background:'rgba(0,210,211,0.04)', borderRadius:8, padding:'9px', textAlign:'center' }}>
                      <div style={{ fontSize:20, fontWeight:'bold', color:'#00D2D3' }}>{s.value}</div>
                      <div style={{ fontSize:9, color:'#4A4A6A', letterSpacing:1 }}>{s.label.toUpperCase()}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Timeline */}
            <div style={{ background:'#1A1A2E', border:'1px solid #2A2A4A', borderRadius:14, padding:18, display:'flex', flexDirection:'column' }}>
              <div style={{ marginBottom:14, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <div>
                  <div style={{ fontSize:12, color:'#00D2D3', letterSpacing:2, fontWeight:'bold' }}>
                    {new Date(selectedDate+'T12:00:00').toLocaleDateString('tr-TR',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).toUpperCase()}
                  </div>
                  <div style={{ fontSize:10, color:'#4A4A6A', marginTop:3 }}>
                    {dayApps.length===0 ? '✅ Yazıcı müsait' : `${dayApps.length} randevu`}
                  </div>
                </div>
                <button onClick={openAdd} style={{
                  padding:'6px 14px', borderRadius:6, border:'1px solid rgba(0,210,211,0.25)',
                  background:'rgba(0,210,211,0.07)', color:'#00D2D3',
                  cursor:'pointer', fontSize:11, fontFamily:'inherit'
                }}>+ Ekle</button>
              </div>
              <div style={{ overflowY:'auto', flex:1, maxHeight:580 }}>
                {HOURS.map(h => {
                  const hourApps = dayApps.filter(a => {
                    const s = timeToMinutes(a.start_time);
                    const e = s + Math.round(a.duration*60);
                    return s < (h+1)*60 && e > h*60;
                  });
                  return (
                    <div key={h} className="timeline-item" style={{ display:'flex', minHeight:46, borderBottom:'1px solid #13131F', transition:'background 0.1s' }}>
                      <div style={{ width:50, flexShrink:0, padding:'5px 10px 5px 0', textAlign:'right', fontSize:10, color:h>=8&&h<=20?'#3A3A6A':'#202030', borderRight:'1px solid #18182A', userSelect:'none' }}>
                        {String(h).padStart(2,'0')}:00
                      </div>
                      <div style={{ flex:1, padding:'4px 8px', display:'flex', flexWrap:'wrap', gap:4, alignItems:'flex-start' }}>
                        {hourApps.map(a => {
                          const endTime = minutesToTime(timeToMinutes(a.start_time)+Math.round(a.duration*60));
                          const color = getTeamColor(a.team,teamsForColor);
                          return (
                            <div key={a.id} onClick={() => openEdit(a)} style={{
                              background:color+'16', border:`1px solid ${color}40`,
                              borderLeft:`3px solid ${color}`,
                              borderRadius:6, padding:'4px 10px',
                              cursor:'pointer', fontSize:11, color,
                              display:'flex', gap:8, alignItems:'center'
                            }}>
                              <span style={{ fontWeight:'bold' }}>{a.team}</span>
                              <span style={{ opacity:0.65 }}>{a.start_time}–{endTime}</span>
                              <span style={{ opacity:0.4, fontSize:10 }}>{a.duration}s</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* LIST VIEW */}
        {view==='list' && (
          <div>
            <div style={{ marginBottom:14, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div style={{ fontSize:10, color:'#4A4A6A', letterSpacing:3 }}>TÜM RANDEVULAR — {appointments.length} KAYIT</div>
              {appointments.length>0 && (
                <div style={{ fontSize:11, color:'#3A3A5A' }}>Toplam: {appointments.reduce((s,a)=>s+Number(a.duration),0).toFixed(1)} saat</div>
              )}
            </div>
            {appointments.length===0 ? (
              <div style={{ textAlign:'center', color:'#2A2A4A', padding:'80px 0', fontSize:12, letterSpacing:3 }}>
                <div style={{ fontSize:36, marginBottom:14, opacity:0.2 }}>⬡</div>HENÜZ RANDEVU YOK
              </div>
            ) : (
              <div style={{ display:'grid', gap:8 }}>
                {[...appointments]
                  .sort((a,b) => a.date.localeCompare(b.date) || timeToMinutes(a.start_time)-timeToMinutes(b.start_time))
                  .map(a => {
                    const endTime = minutesToTime(timeToMinutes(a.start_time)+Math.round(Number(a.duration)*60));
                    const color = getTeamColor(a.team,teamsForColor);
                    const isPast = a.date < todayStr;
                    return (
                      <div key={a.id} className="app-card" style={{
                        background:'#1A1A2E', border:'1px solid #2A2A4A',
                        borderLeft:`4px solid ${isPast?color+'44':color}`,
                        borderRadius:10, padding:'13px 18px',
                        display:'flex', alignItems:'center', gap:16,
                        opacity:isPast?0.55:1, transition:'border-color 0.2s'
                      }}>
                        <div style={{ width:9, height:9, borderRadius:2, background:isPast?color+'55':color, flexShrink:0 }}/>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontWeight:'bold', color:isPast?color+'88':color, fontSize:12, letterSpacing:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{a.team}</div>
                          <div style={{ fontSize:10, color:'#4A4A6A', marginTop:2 }}>
                            {new Date(a.date+'T12:00:00').toLocaleDateString('tr-TR',{weekday:'short',day:'numeric',month:'short',year:'numeric'})}
                          </div>
                        </div>
                        <div style={{ textAlign:'center', flexShrink:0 }}>
                          <div style={{ fontSize:13, fontWeight:'bold', color:'#E0E0F0' }}>{a.start_time} – {endTime}</div>
                          <div style={{ fontSize:10, color:'#4A4A6A', marginTop:2 }}>{a.duration} SAAT</div>
                        </div>
                        {isPast && <div style={{ fontSize:9, color:'#2A2A4A', letterSpacing:1 }}>GEÇMİŞ</div>}
                        <button onClick={() => openEdit(a)} style={{
                          padding:'5px 13px', borderRadius:6, border:'1px solid #2A2A4A',
                          background:'transparent', color:'#00D2D3', cursor:'pointer',
                          fontSize:10, fontFamily:'inherit', letterSpacing:1, flexShrink:0
                        }}>DÜZENLE</button>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modal */}
      {modal && (
        <div style={{
          position:'fixed', inset:0, background:'rgba(0,0,0,0.78)',
          display:'flex', alignItems:'center', justifyContent:'center', zIndex:200,
          backdropFilter:'blur(6px)'
        }} onClick={e => { if(e.target===e.currentTarget && !saving) setModal(null); }}>
          <div style={{
            background:'#111120', border:'1px solid #252540',
            borderRadius:18, padding:28, width:410, maxWidth:'92vw',
            boxShadow:'0 24px 80px rgba(0,0,0,0.9)',
            animation:'fadeSlide 0.2s ease'
          }}>
            <div style={{ fontWeight:'bold', fontSize:12, letterSpacing:2, color:'#00D2D3', marginBottom:4 }}>
              {modal.mode==='add' ? 'YENİ RANDEVU' : 'RANDEVU DÜZENLE'}
            </div>
            <div style={{ fontSize:10, color:'#3A3A5A', marginBottom:20, letterSpacing:1 }}>
              {modal.mode==='add' ? 'Çakışan saatlere randevu eklenemez.' : 'Değişikliklerinizi kaydedin veya randevuyu silin.'}
            </div>

            <label style={labelStyle}>Takım Adı</label>
            <input value={form.team} onChange={e=>{setForm(f=>({...f,team:e.target.value}));setError('');}}
              placeholder="Örn: Takım Alpha" style={inputStyle} autoFocus disabled={saving} />

            <label style={labelStyle}>Tarih</label>
            <input type="date" value={form.date} onChange={e=>{setForm(f=>({...f,date:e.target.value}));setError('');}} style={inputStyle} disabled={saving} />

            <label style={labelStyle}>Başlangıç Saati</label>
            <input type="time" value={form.startTime} onChange={e=>{setForm(f=>({...f,startTime:e.target.value}));setError('');}} style={inputStyle} disabled={saving} />

            <label style={labelStyle}>Tahmini Baskı Süresi (Saat)</label>
            <input type="number" min="0.5" max="24" step="0.5" value={form.duration}
              onChange={e=>{setForm(f=>({...f,duration:e.target.value}));setError('');}} style={inputStyle} disabled={saving} />

            {form.startTime && parseFloat(form.duration)>0 && !isNaN(parseFloat(form.duration)) && (
              <div style={{ fontSize:11, color:'#4ECDC4', marginTop:8, letterSpacing:1 }}>
                📌 Bitiş saati: <strong>{minutesToTime(timeToMinutes(form.startTime)+Math.round(parseFloat(form.duration)*60))}</strong>
              </div>
            )}

            {error && (
              <div style={{
                background:'rgba(255,80,80,0.07)', border:'1px solid rgba(255,80,80,0.2)',
                borderRadius:8, padding:'10px 14px', fontSize:11, color:'#FF8080',
                marginTop:12, whiteSpace:'pre-line', lineHeight:1.7
              }}>{error}</div>
            )}

            <div style={{ display:'flex', gap:8, marginTop:18 }}>
              <button onClick={handleSave} disabled={saving} style={{
                flex:1, padding:'11px 0', borderRadius:8, border:'none',
                background:saving ? '#1A2A2A' : 'linear-gradient(135deg,#00D2D3,#54A0FF)',
                color:saving ? '#3A5A5A' : '#0D0D12', fontWeight:'bold', cursor:saving?'wait':'pointer',
                fontSize:12, fontFamily:'inherit', letterSpacing:1
              }}>{saving ? 'KAYDEDİLİYOR...' : 'KAYDET'}</button>
              {modal.mode==='edit' && (
                <button onClick={() => handleDelete(modal.app.id)} disabled={saving} style={{
                  padding:'11px 15px', borderRadius:8,
                  border:'1px solid rgba(255,100,100,0.3)',
                  background:'rgba(255,100,100,0.06)',
                  color:'#FF7070', cursor:saving?'wait':'pointer', fontSize:12, fontFamily:'inherit'
                }}>SİL</button>
              )}
              <button onClick={() => !saving && setModal(null)} style={{
                padding:'11px 15px', borderRadius:8,
                border:'1px solid #252540', background:'transparent',
                color:'#5A5A7A', cursor:'pointer', fontSize:12, fontFamily:'inherit'
              }}>İPTAL</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const navBtn = {
  background:'transparent', border:'1px solid #2A2A4A', color:'#5A5A7A',
  borderRadius:6, width:26, height:26, cursor:'pointer', fontSize:15,
  display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'inherit'
};
const labelStyle = {
  display:'block', fontSize:9, color:'#4A4A6A',
  letterSpacing:2, marginBottom:5, marginTop:13
};
const inputStyle = {
  width:'100%', padding:'10px 12px', borderRadius:8,
  border:'1px solid #2A2A4A', background:'#0A0A18',
  color:'#E8E8F0', fontSize:13, fontFamily:'inherit',
  boxSizing:'border-box', outline:'none', transition:'all 0.2s'
};
