import { useState, useMemo, useEffect, useCallback } from 'react';
import { supabase } from './supabaseClient';

const ADMIN_PASSWORD = '145314';

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

// Bir randevunun kapladığı tüm tarihleri döndür (Timezone kayması düzeltildi)
function getOccupiedDates(a) {
  const startMin = timeToMinutes(a.start_time);
  const endMin = startMin + Math.round(parseFloat(a.duration) * 60);
  const dates = [];
  
  // Tarihi YYYY-MM-DD formatından güvenli bir şekilde alıp yerel saatle kuruyoruz
  const [y, m, d] = a.date.split('-').map(Number);
  const base = new Date(y, m - 1, d); 

  const dayCount = Math.ceil(endMin / (24 * 60));
  // 0 saat bile olsa en azından başladığı günü kapsasın
  for (let i = 0; i < Math.max(1, dayCount); i++) {
    const current = new Date(base);
    current.setDate(current.getDate() + i);
    
    // toISOString yerine manuel formatlama yapıyoruz
    const dateStr = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
    dates.push(dateStr);
  }
  return dates;
}

// Bir randevunun belirli bir günde kaç dakika işgal ettiğini hesapla (Timezone kayması düzeltildi)
function getMinutesOnDate(a, dateStr) {
  const [y1, m1, d1] = a.date.split('-').map(Number);
  const [y2, m2, d2] = dateStr.split('-').map(Number);

  const date1 = new Date(y1, m1 - 1, d1);
  const date2 = new Date(y2, m2 - 1, d2);

  // Gün farkını kesin olarak buluyoruz
  const diffDays = Math.round((date2 - date1) / 86400000);

  // Eğer kontrol edilen tarih, randevunun başladığı tarihten önceyse atla
  if (diffDays < 0) return null;

  const startMin = timeToMinutes(a.start_time);
  const totalDur = Math.round(parseFloat(a.duration) * 60);
  const endMin = startMin + totalDur;

  const dayStartMin = diffDays * 24 * 60;
  const dayEndMin = dayStartMin + 24 * 60;

  // Bu günün başlangıç/bitiş dakikaları (randevunun başından itibaren)
  const overlapStart = Math.max(startMin, dayStartMin);
  const overlapEnd = Math.min(endMin, dayEndMin);
  
  return overlapEnd > overlapStart ? { from: overlapStart - dayStartMin, to: overlapEnd - dayStartMin } : null;
}

// Çakışma kontrolünü de timezone kaymasından arındırıyoruz
function findConflict(appointments, newApp, excludeId = null) {
  const newStart = timeToMinutes(newApp.startTime);
  const dur = parseFloat(newApp.duration);
  if (isNaN(dur) || dur <= 0) return null;
  const newEnd = newStart + Math.round(dur * 60);

  const [ny, nm, nd] = newApp.date.split('-').map(Number);
  const newBaseMs = new Date(ny, nm - 1, nd).getTime();

  for (const a of appointments) {
    if (a.id === excludeId) continue;
    const aStart = timeToMinutes(a.start_time);
    const aDur = Math.round(parseFloat(a.duration) * 60);
    const aEnd = aStart + aDur;

    const [ay, am, ad] = a.date.split('-').map(Number);
    const aBaseMs = new Date(ay, am - 1, ad).getTime();

    const diffMins = (aBaseMs - newBaseMs) / 60000;
    const aAbsStart = diffMins + aStart;
    const aAbsEnd = diffMins + aEnd;
    
    if (newStart < aAbsEnd && newEnd > aAbsStart) return a;
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
  const [form, setForm] = useState({ team: '', date: todayStr, startTime: '09:00', duration: '1', password: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminInput, setAdminInput] = useState('');
  const [adminError, setAdminError] = useState('');
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [toast, setToast] = useState(null);
  const [pendingEdit, setPendingEdit] = useState(null);
  const [teamPwInput, setTeamPwInput] = useState('');
  const [teamPwError, setTeamPwError] = useState('');

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

  const teamsForColor = useMemo(() => [...new Set(appointments.map(a => a.team))], [appointments]);

  function openAdd() {
    setForm({ team: '', date: selectedDate, startTime: '09:00', duration: '1', password: '' });
    setError('');
    setModal('add');
  }

  function clickEdit(app) {
    if (isAdmin) {
      setForm({ team: app.team, date: app.date, startTime: app.start_time, duration: String(app.duration), password: '' });
      setError('');
      setModal({ mode: 'edit', app });
    } else {
      setPendingEdit(app);
      setTeamPwInput('');
      setTeamPwError('');
      setModal('team-password');
    }
  }

  function handleTeamPasswordSubmit() {
    if (!teamPwInput.trim()) { setTeamPwError('Şifre boş olamaz.'); return; }
    if (teamPwInput === ADMIN_PASSWORD) {
      setForm({ team: pendingEdit.team, date: pendingEdit.date, startTime: pendingEdit.start_time, duration: String(pendingEdit.duration), password: '' });
      setError('');
      setModal({ mode: 'edit', app: pendingEdit });
      return;
    }
    if (teamPwInput !== pendingEdit.team_password) {
      setTeamPwError('❌ Şifre yanlış. Randevuyu oluştururken girdiğiniz şifreyi girin.');
      return;
    }
    setForm({ team: pendingEdit.team, date: pendingEdit.date, startTime: pendingEdit.start_time, duration: String(pendingEdit.duration), password: pendingEdit.team_password });
    setError('');
    setModal({ mode: 'edit', app: pendingEdit });
  }

  function handleAdminLogin() {
    if (adminInput === ADMIN_PASSWORD) {
      setIsAdmin(true);
      setModal(null);
      setAdminInput('');
      setAdminError('');
      showToast('🔑 Admin girişi başarılı!');
    } else {
      setAdminError('❌ Yanlış şifre.');
    }
  }

  async function handleSave() {
    if (!form.team.trim()) { setError('Takım adı boş olamaz.'); return; }
    if (!form.date) { setError('Tarih seçiniz.'); return; }
    const dur = parseFloat(form.duration);
    if (isNaN(dur) || dur <= 0 || dur > 720) { setError('Süre 0.5 ile 720 saat (30 gün) arasında olmalı.'); return; }
    const startMin = timeToMinutes(form.startTime);
    if (startMin < timeToMinutes('09:00') || startMin > timeToMinutes('17:00')) {
      setError('⚠️ Baskıya başlangıç saati 09:00–17:00 arasında olmalıdır.\nBaskı süresi gece devam edebilir.');
      return;
    }
    if (modal === 'add' && !form.password.trim()) { setError('Randevu şifresi boş olamaz.'); return; }

    setSaving(true);
    try {
      const { data: freshData, error: fetchError } = await supabase.from('appointments').select('*');
      if (fetchError) throw fetchError;

      const excludeId = modal !== 'add' ? modal.app.id : null;
      const normalizedApps = (freshData || []).map(a => ({ ...a, startTime: a.start_time }));
      const conflict = findConflict(normalizedApps, { ...form, duration: dur }, excludeId);

      if (conflict) {
        const conflictEnd = minutesToTime(timeToMinutes(conflict.start_time) + Math.round(conflict.duration * 60));
        setError(`⚠️ Çakışma!\n"${conflict.team}" takımı ${conflict.start_time}–${conflictEnd} saatleri arasında yazıcıyı kullanıyor.`);
        setSaving(false);
        return;
      }

      if (modal === 'add') {
        const { error } = await supabase.from('appointments').insert({
          team: form.team.trim(),
          date: form.date,
          start_time: form.startTime,
          duration: dur,
          team_password: form.password.trim(),
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

  const appsForDay = (dateStr) => appointments.filter(a => getOccupiedDates(a).includes(dateStr));
  const dayApps = appointments
    .filter(a => getOccupiedDates(a).includes(selectedDate))
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
      `}</style>

      {/* Toast */}
      {toast && (
        <div style={{
          position:'fixed', top:20, right:20, zIndex:9999,
          background: toast.type==='warning'?'#1A1008':toast.type==='error'?'#1A0808':'#081818',
          border:`1px solid ${toast.type==='warning'?'#FF9F43':toast.type==='error'?'#FF6B6B':'#00D2D3'}`,
          borderRadius:10, padding:'12px 20px', fontSize:12,
          color: toast.type==='warning'?'#FF9F43':toast.type==='error'?'#FF6B6B':'#00D2D3',
          boxShadow:'0 8px 32px rgba(0,0,0,0.7)',
          animation:'fadeSlide 0.25s ease', letterSpacing:1, maxWidth:320
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
        <div style={{ maxWidth:1140, margin:'0 auto', padding:'14px 0' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:12 }}>
            <div style={{ display:'flex', alignItems:'center', gap:14 }}>
              <div style={{ width:44, height:44, background:'linear-gradient(135deg,#00D2D3,#54A0FF)', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, boxShadow:'0 0 20px rgba(0,210,211,0.4)' }}>⬡</div>
              <div>
                <div style={{ fontSize:17, fontWeight:'bold', letterSpacing:3, color:'#00D2D3' }}>3D PRİNTER</div>
                <div style={{ fontSize:10, color:'#5A5A7A', letterSpacing:3 }}>RANDEVU TAKİP SİSTEMİ</div>
              </div>
            </div>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
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
              {isAdmin ? (
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <div style={{ fontSize:10, color:'#FECA57', letterSpacing:1, padding:'6px 12px', background:'rgba(254,202,87,0.1)', border:'1px solid rgba(254,202,87,0.3)', borderRadius:6 }}>
                    🔑 ADMİN
                  </div>
                  <button onClick={() => { setIsAdmin(false); showToast('Admin çıkışı yapıldı.', 'warning'); }} style={{
                    padding:'6px 12px', borderRadius:6, border:'1px solid #2A2A4A',
                    background:'transparent', color:'#5A5A7A', cursor:'pointer', fontSize:10, fontFamily:'inherit'
                  }}>Çıkış</button>
                </div>
              ) : (
                <button onClick={() => { setAdminInput(''); setAdminError(''); setModal('admin-login'); }} style={{
                  padding:'7px 14px', borderRadius:6, border:'1px solid #3A3A5A',
                  background:'transparent', color:'#5A5A7A', cursor:'pointer', fontSize:10,
                  fontFamily:'inherit', letterSpacing:1
                }}>🔑 Admin</button>
              )}
            </div>
          </div>
          <div style={{ marginTop:8, display:'flex', alignItems:'center', justifyContent:'flex-end', gap:8 }}>
            <div style={{ width:1, height:12, background:'#2A3A5A' }}/>
            <span style={{ fontSize:11, color:'#4A6A8A', letterSpacing:1.5, fontStyle:'italic' }}>
              Dr. Öğr. Üyesi Kadir Özbek
            </span>
          </div>
        </div>
      </div>

      <div style={{ maxWidth:1140, margin:'0 auto', padding:'22px 24px' }}>

        {/* CALENDAR VIEW */}
        {view==='calendar' && (
          <div style={{ display:'grid', gridTemplateColumns:'290px 1fr', gap:20 }}>
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
                    const overlap = getMinutesOnDate(a, selectedDate);
                    if (!overlap) return false;
                    return overlap.from < (h+1)*60 && overlap.to > h*60;
                  });
                  return (
                    <div key={h} style={{ display:'flex', minHeight:46, borderBottom:'1px solid #13131F' }}>
                      <div style={{ width:50, flexShrink:0, padding:'5px 10px 5px 0', textAlign:'right', fontSize:10, color:h>=9&&h<=17?'#3A3A6A':'#202030', borderRight:'1px solid #18182A', userSelect:'none' }}>
                        {String(h).padStart(2,'0')}:00
                      </div>
                      <div style={{ flex:1, padding:'4px 8px', display:'flex', flexWrap:'wrap', gap:4, alignItems:'flex-start' }}>
                        {hourApps.map(a => {
                          const overlap = getMinutesOnDate(a, selectedDate);
                          const isStartDay = a.date === selectedDate;
                          const totalEndMin = timeToMinutes(a.start_time) + Math.round(a.duration*60);
                          
                          // Timezone'dan arındırılmış bitiş tarihi hesaplaması
                          const [ay, am, ad] = a.date.split('-').map(Number);
                          const endDate = new Date(ay, am - 1, ad);
                          endDate.setMinutes(endDate.getMinutes() + totalEndMin);
                          const endDateStr = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
                          
                          const isEndDay = endDateStr === selectedDate;
                          const displayStart = isStartDay ? a.start_time : '00:00';
                          const displayEnd = isEndDay ? minutesToTime(overlap.to) : '→ ertesi gün';
                          const color = getTeamColor(a.team,teamsForColor);
                          
                          return (
                            <div key={a.id} onClick={() => clickEdit(a)} style={{
                              background:color+'16', border:`1px solid ${color}40`,
                              borderLeft:`3px solid ${color}`,
                              borderRadius:6, padding:'4px 10px',
                              cursor:'pointer', fontSize:11, color,
                              display:'flex', gap:8, alignItems:'center'
                            }}>
                              <span style={{ fontWeight:'bold' }}>{a.team}</span>
                              <span style={{ opacity:0.65 }}>{displayStart}–{displayEnd}</span>
                              <span style={{ opacity:0.4, fontSize:10 }}>{a.duration}s</span>
                              {!isStartDay && <span style={{ fontSize:9, opacity:0.5, background:color+'22', padding:'1px 5px', borderRadius:3 }}>devam</span>}
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
                      <div key={a.id} style={{
                        background:'#1A1A2E', border:'1px solid #2A2A4A',
                        borderLeft:`4px solid ${isPast?color+'44':color}`,
                        borderRadius:10, padding:'13px 18px',
                        display:'flex', alignItems:'center', gap:16,
                        opacity:isPast?0.55:1
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
                        <button onClick={() => clickEdit(a)} style={{
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

      {/* KULLANIM KILAVUZU */}
      <div style={{ background:'#0F0F1A', borderTop:'1px solid #1E1E32', padding:'28px 24px', marginTop:20 }}>
        <div style={{ maxWidth:1140, margin:'0 auto' }}>
          <div style={{ fontSize:10, color:'#3A3A5A', letterSpacing:3, marginBottom:20, display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ flex:1, height:1, background:'#1E1E32' }}/>
            NASIL KULLANILIR?
            <div style={{ flex:1, height:1, background:'#1E1E32' }}/>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:16 }}>
            {[
              {
                icon:'📅',
                title:'Randevu Ekle',
                steps:[
                  '+ RANDEVU EKLE butonuna tıkla',
                  'Takım adı, tarih, saat ve süreyi gir',
                  'Kendine bir şifre belirle (unutma!)',
                  'Kaydet — çakışma varsa sistem uyarır',
                ]
              },
              {
                icon:'✏️',
                title:'Randevu Düzenle / Sil',
                steps:[
                  'Takvimde randevuna tıkla',
                  'Randevunu oluştururken belirlediğin şifreyi gir',
                  'Değişiklik yap ve kaydet',
                  'Ya da sil butonuna bas',
                ]
              },
              {
                icon:'👁️',
                title:'Takvimi İzle',
                steps:[
                  'Sol takvimde dolu günler nokta ile işaretlenir',
                  'Bir güne tıkla → sağda saatlik plan görünür',
                  'Liste görünümü için 📋 LİSTE butonunu kullan',
                  'Veriler herkese anlık olarak güncellenir',
                ]
              },
              {
                icon:'🔑',
                title:'Şifremi Unuttum',
                steps:[
                  'Sistem adminine (Dr. Kadir Özbek) haber ver',
                  'Admin randevuyu silip yeniden oluşturmanı sağlar',
                  'Admin girişi için sağ üstteki 🔑 Admin butonunu kullan',
                  'Admin tüm randevulara erişebilir',
                ]
              },
            ].map(card => (
              <div key={card.title} style={{
                background:'#141422', border:'1px solid #1E1E32',
                borderRadius:12, padding:16
              }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
                  <span style={{ fontSize:16 }}>{card.icon}</span>
                  <span style={{ fontSize:11, fontWeight:'bold', color:'#00D2D3', letterSpacing:1 }}>{card.title}</span>
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
                  {card.steps.map((s,i) => (
                    <div key={i} style={{ display:'flex', gap:9, alignItems:'flex-start' }}>
                      <div style={{ width:16, height:16, borderRadius:'50%', background:'rgba(0,210,211,0.08)', border:'1px solid #2A2A4A', display:'flex', alignItems:'center', justifyContent:'center', fontSize:8, color:'#00D2D3', flexShrink:0, marginTop:1 }}>{i+1}</div>
                      <span style={{ fontSize:11, color:'#6A6A8A', lineHeight:1.5 }}>{s}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ADMIN LOGIN MODAL */}
      {modal==='admin-login' && (
        <div style={overlayStyle} onClick={e => { if(e.target===e.currentTarget) setModal(null); }}>
          <div style={modalBoxStyle}>
            <div style={{ fontSize:13, fontWeight:'bold', color:'#FECA57', letterSpacing:2, marginBottom:6 }}>🔑 ADMİN GİRİŞİ</div>
            <div style={{ fontSize:10, color:'#3A3A5A', marginBottom:20, letterSpacing:1 }}>Tüm randevulara erişmek için admin şifresini girin.</div>
            <label style={labelStyle}>Admin Şifresi</label>
            <input type="password" value={adminInput} onChange={e=>{setAdminInput(e.target.value);setAdminError('');}}
              onKeyDown={e => e.key==='Enter' && handleAdminLogin()}
              placeholder="••••••" style={inputStyle} autoFocus />
            {adminError && <div style={errorStyle}>{adminError}</div>}
            <div style={{ display:'flex', gap:8, marginTop:18 }}>
              <button onClick={handleAdminLogin} style={primaryBtnStyle}>GİRİŞ YAP</button>
              <button onClick={() => setModal(null)} style={cancelBtnStyle}>İPTAL</button>
            </div>
          </div>
        </div>
      )}

      {/* TEAM PASSWORD MODAL */}
      {modal==='team-password' && (
        <div style={overlayStyle} onClick={e => { if(e.target===e.currentTarget) setModal(null); }}>
          <div style={modalBoxStyle}>
            <div style={{ fontSize:13, fontWeight:'bold', color:'#00D2D3', letterSpacing:2, marginBottom:6 }}>🔒 RANDEVU DOĞRULAMA</div>
            <div style={{ fontSize:10, color:'#3A3A5A', marginBottom:6, letterSpacing:1 }}>
              Bu randevuyu düzenlemek için oluştururken belirlediğiniz şifreyi girin.
            </div>
            <div style={{ fontSize:11, color:'#4ECDC4', marginBottom:20 }}>
              Takım: <strong>{pendingEdit?.team}</strong>
            </div>
            <label style={labelStyle}>Randevu Şifresi</label>
            <input type="password" value={teamPwInput} onChange={e=>{setTeamPwInput(e.target.value);setTeamPwError('');}}
              onKeyDown={e => e.key==='Enter' && handleTeamPasswordSubmit()}
              placeholder="••••••" style={inputStyle} autoFocus />
            {teamPwError && <div style={errorStyle}>{teamPwError}</div>}
            <div style={{ display:'flex', gap:8, marginTop:18 }}>
              <button onClick={handleTeamPasswordSubmit} style={primaryBtnStyle}>DEVAM ET</button>
              <button onClick={() => setModal(null)} style={cancelBtnStyle}>İPTAL</button>
            </div>
          </div>
        </div>
      )}

      {/* ADD / EDIT MODAL */}
      {modal && modal !== 'admin-login' && modal !== 'team-password' && (
        <div style={overlayStyle} onClick={e => { if(e.target===e.currentTarget && !saving) setModal(null); }}>
          <div style={modalBoxStyle}>
            <div style={{ fontWeight:'bold', fontSize:12, letterSpacing:2, color:'#00D2D3', marginBottom:4 }}>
              {modal==='add' ? 'YENİ RANDEVU' : 'RANDEVU DÜZENLE'}
            </div>
            <div style={{ fontSize:10, color:'#3A3A5A', marginBottom:20, letterSpacing:1 }}>
              {modal==='add' ? 'Randevunuzu korumak için bir şifre belirleyin.' : 'Değişikliklerinizi kaydedin veya randevuyu silin.'}
            </div>

            <label style={labelStyle}>Takım Adı</label>
            <input value={form.team} onChange={e=>{setForm(f=>({...f,team:e.target.value}));setError('');}}
              placeholder="Örn: Takım Alpha" style={inputStyle} autoFocus disabled={saving} />

            <label style={labelStyle}>Tarih</label>
            <input type="date" value={form.date} onChange={e=>{setForm(f=>({...f,date:e.target.value}));setError('');}} style={inputStyle} disabled={saving} />

            <label style={labelStyle}>Başlangıç Saati <span style={{color:'#5A6A8A',fontWeight:'normal'}}>(09:00–17:00)</span></label>
            <input type="time" value={form.startTime} min="09:00" max="17:00" onChange={e=>{setForm(f=>({...f,startTime:e.target.value}));setError('');}} style={inputStyle} disabled={saving} />

            <label style={labelStyle}>Tahmini Baskı Süresi (Saat)</label>
            <input type="number" min="0.5" max="720" step="0.5" value={form.duration}
              onChange={e=>{setForm(f=>({...f,duration:e.target.value}));setError('');}} style={inputStyle} disabled={saving} />

            {modal==='add' && (
              <>
                <label style={labelStyle}>Randevu Şifresi <span style={{ color:'#FF6B6B' }}>(unutmayın!)</span></label>
                <input type="password" value={form.password} onChange={e=>{setForm(f=>({...f,password:e.target.value}));setError('');}}
                  placeholder="Randevunuzu koruyacak şifre" style={inputStyle} disabled={saving} />
              </>
            )}

            {form.startTime && parseFloat(form.duration)>0 && !isNaN(parseFloat(form.duration)) && (
              <div style={{ fontSize:11, color:'#4ECDC4', marginTop:8, letterSpacing:1 }}>
                📌 Bitiş saati: <strong>{minutesToTime(timeToMinutes(form.startTime)+Math.round(parseFloat(form.duration)*60))}</strong>
              </div>
            )}

            {error && <div style={errorStyle}>{error}</div>}

            <div style={{ display:'flex', gap:8, marginTop:18 }}>
              <button onClick={handleSave} disabled={saving} style={{
                ...primaryBtnStyle,
                background: saving ? '#1A2A2A' : 'linear-gradient(135deg,#00D2D3,#54A0FF)',
                color: saving ? '#3A5A5A' : '#0D0D12',
                cursor: saving ? 'wait' : 'pointer',
              }}>{saving ? 'KAYDEDİLİYOR...' : 'KAYDET'}</button>
              {modal !== 'add' && (
                <button onClick={() => handleDelete(modal.app.id)} disabled={saving} style={{
                  padding:'11px 15px', borderRadius:8,
                  border:'1px solid rgba(255,100,100,0.3)',
                  background:'rgba(255,100,100,0.06)',
                  color:'#FF7070', cursor:saving?'wait':'pointer', fontSize:12, fontFamily:'inherit'
                }}>SİL</button>
              )}
              <button onClick={() => !saving && setModal(null)} style={cancelBtnStyle}>İPTAL</button>
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
const overlayStyle = {
  position:'fixed', inset:0, background:'rgba(0,0,0,0.78)',
  display:'flex', alignItems:'center', justifyContent:'center', zIndex:200,
  backdropFilter:'blur(6px)'
};
const modalBoxStyle = {
  background:'#111120', border:'1px solid #252540',
  borderRadius:18, padding:28, width:410, maxWidth:'92vw',
  boxShadow:'0 24px 80px rgba(0,0,0,0.9)',
  animation:'fadeSlide 0.2s ease'
};
const primaryBtnStyle = {
  flex:1, padding:'11px 0', borderRadius:8, border:'none',
  background:'linear-gradient(135deg,#00D2D3,#54A0FF)',
  color:'#0D0D12', fontWeight:'bold', cursor:'pointer',
  fontSize:12, fontFamily:'inherit', letterSpacing:1
};
const cancelBtnStyle = {
  padding:'11px 15px', borderRadius:8,
  border:'1px solid #252540', background:'transparent',
  color:'#5A5A7A', cursor:'pointer', fontSize:12, fontFamily:'inherit'
};
const errorStyle = {
  background:'rgba(255,80,80,0.07)', border:'1px solid rgba(255,80,80,0.2)',
  borderRadius:8, padding:'10px 14px', fontSize:11, color:'#FF8080',
  marginTop:12, whiteSpace:'pre-line', lineHeight:1.7
};