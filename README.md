# Helmd — Secure Docker Daemon Agent

**Helmd** คือ Lightweight Agent ขนาดเล็กสำหรับติดตั้งบน Docker Host (เช่น VPS) เพื่อทำหน้าที่เป็นสะพานเชื่อมต่อระหว่าง **Helm Dashboard** และ **Docker Daemon** อย่างปลอดภัย โดยใช้ระบบ API Key Authentication แทนการเปิดพอร์ต Docker TCP (2375) ทิ้งไว้ซึ่งมีความเสี่ยงสูง

## คุณสมบัติเด่น
- 🛡️ **ความปลอดภัยสูง**: เชื่อมต่อกับ Docker ผ่าน Unix Socket ภายในเครื่องเท่านั้น ไม่ต้องเปิดพอร์ต Docker ให้โลกภายนอกเห็น
- 🔑 **API Key Auth**: ทุก Request ต้องมี API Key ที่ถูกต้อง และมีการเก็บ Key ในรูปแบบ Hash (SHA256) พร้อมสิทธิ์การเข้าถึงไฟล์คอนฟิกที่เข้มงวด
- 🔒 **IP Whitelist**: (ใหม่!) ระบบป้องกันในตัวที่อนุญาตให้เฉพาะ IP หรือ Domain ที่กำหนดเท่านั้นที่สามารถเชื่อมต่อได้
- 📊 **Precision Monitoring**: ระบบส่งข้อมูล CPU แยกระดับ Host แบบ Real-time (Delta-based) ให้ความแม่นยำสูงสุด
- 🚀 **รองรับทุกฟีเจอร์**: ครอบคลุมการจัดการ Containers, Images, Volumes, Networks และ Stacks (Docker Compose)
- 💻 **Terminal ในตัว**: รองรับ Interactive Terminal ผ่าน WebSocket ใช้งานได้ลื่นไหลเหมือนพิมพ์ในเครื่องจริงๆ

---

## ขั้นตอนการติดตั้งและ Deploy (บน VPS)

### 1. เตรียมความพร้อม
ก๊อปปี้โฟลเดอร์ `helmd` ไปไว้ที่ VPS ของคุณ หรือ Clone โปรเจคลงไป

### 2. รันด้วย Docker Compose (แนะนำ)
ใช้คำสั่งนี้เพื่อเริ่มการทำงานของ Helmd:
```bash
docker compose up -d
```

### 3. ค้นหา API Key ของคุณ
เมื่อรันครั้งแรก ระบบจะสุ่มสร้าง API Key ให้โดยอัตโนมัติ คุณสามารถดูได้จาก logs:
```bash
docker logs helmd
```
คุณจะพบข้อความลักษณะนี้:
> `Your API Key: hd_xxxxxxxxxxxxxxxxxxxxxxxxxxx`  
> `⚠ SAVE THIS KEY NOW — it will NOT be shown again!`

> [!IMPORTANT]
> **จดจำ API Key นี้ไว้ให้ดี** เพราะระบบจะแสดงเพียงครั้งเดียวเท่านั้น (ในรอบหน้าจะถูกเก็บเป็น Hash เพื่อความปลอดภัย)

---

## การเชื่อมต่อกับ Helm Dashboard

1. เข้าไปที่ **Helm Dashboard** -> ไปที่เมนู **Settings**
2. คลิกปุ่ม **"+ Add Host"**
3. เลือก Connection Type เป็น **"Helmd Agent"**
4. กรอกข้อมูล:
   - **Host Name**: ตั้งชื่อเรียก เช่น "Production VPS"
   - **Helmd URL**: ใส่ IP ของ VPS พร้อมพอร์ต 9117 (เช่น `http://103.xx.xx.xx:9117`)
   - **API Key**: นำ Key ที่ได้จากขั้นตอนก่อนหน้ามาใส่
5. กดปุ่ม **"🔌 Connection"** เพื่อตรวจสอบความถูกต้อง
6. หากสำเร็จ ให้กด **"Save Host"**

---

## ฟีเจอร์ความปลอดภัย (Security Features)

### 1. การจัดการ IP Whitelist
คุณสามารถจำกัดสิทธิ์การเข้าถึง Helmd ได้จากหน้า Dashboard ของ Helm โดยตรง (ในหน้า Settings -> คลิกไอคอนรูปโล่ 🛡️) 
- หาก Whitelist ว่างเปล่า: อนุญาตทุก IP
- หากระบุ IP: อนุญาตเฉพาะ IP นั้นๆ
- รองรับ Wildcard: เช่น `1.2.3.*` เพื่ออนุญาตทั้งวง IP

### 2. การจัดการ API Key
หากคุณลืม API Key หรือต้องการสร้างใหม่ สามารถทำได้ผ่าน CLI:
```bash
docker exec -it helmd node src/setup.js reset
```
จากนั้นรีสตาร์ทคอนเทนเนอร์และดู logs อีกครั้งเพื่อรับ Key ใหม่

---

## การดูแลรักษาระบบ (Maintenance)

### หยุดการทำงาน
```bash
docker compose down
```

### ลบข้อมูลทั้งหมด (รวมถึง API Key และ Config ⚠️)
```bash
docker compose down -v
```

---
*Developed for Helm Ecosystem*
