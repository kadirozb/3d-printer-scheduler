# 3D Printer Randevu Takip Sistemi

Supabase veritabanı + Vercel hosting ile çalışan, link paylaşımlı randevu sistemi.

## Özellikler
- Takvim ve liste görünümü
- Gerçek zamanlı güncelleme (birden fazla kullanıcı aynı anda görebilir)
- Çakışma kontrolü
- Supabase'de kalıcı veri saklama

## Deploy Adımları

### 1. GitHub'a Yükle
1. github.com → "New repository" → repo adı: `3d-printer-scheduler`
2. Bilgisayarında bu klasörü aç, terminal:
```
git init
git add .
git commit -m "ilk commit"
git branch -M main
git remote add origin https://github.com/KULLANICI_ADIN/3d-printer-scheduler.git
git push -u origin main
```

### 2. Vercel'e Deploy Et
1. vercel.com → GitHub ile giriş yap
2. "New Project" → GitHub repo'yu seç
3. "Deploy" butonuna bas
4. 2 dakika bekle → link hazır! 🎉

### 3. Linki Paylaş
Vercel sana `https://3d-printer-scheduler-xxx.vercel.app` gibi bir link verir.
Bu linki takımlarla paylaş, herkes randevu ekleyebilir.
