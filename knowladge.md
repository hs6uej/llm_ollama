Knowledge Base: การตั้งค่าและการแก้ปัญหา Local LLM ด้วย Domain Knowledge (Ollama + Docker)📌 Context (บริบท)Environment: Ollama running in Docker Container (ollama-e9cw-ollama-1)Base Model: qwen2.5:3bAccess Point: http://72.62.252.196:32768/api/generateLanguage: Thai (ภาษาไทย)⚙️ การติดตั้ง Ollama ผ่าน Dockerหากต้องการสร้าง Environment แบบเดียวกันตั้งแต่เริ่มต้น สามารถติดตั้ง Ollama ให้รันใน Docker ด้วยคำสั่งพร้อมใช้ด้านล่างนี้:# รัน Ollama ใน Docker (ผูกพอร์ต 11434 ของ container ออกมาที่ 32768 ของเครื่องโฮสต์)
docker run -d \
  -v ollama:/root/.ollama \
  -p 32768:11434 \
  --name ollama-e9cw-ollama-1 \
  --restart always \
  ollama/ollama
🧠 ทำไมถึงเลือกใช้โมเดล Qwen2.5:3b ?กินทรัพยากรน้อย (Low Resource): ด้วยขนาดพารามิเตอร์เพียง 3 พันล้าน (3B) ทำให้สามารถรันบนเครื่องเซิร์ฟเวอร์หรือคอมพิวเตอร์ทั่วไปได้ลื่นไหล ไม่ต้องใช้การ์ดจอ (GPU) ระดับสูงความเร็วสูง (Fast Inference): ตอบสนองได้รวดเร็วมาก เหมาะสำหรับการนำไปต่อยอดทำ API ให้ระบบอื่นเรียกใช้งานเก่งภาษาไทย (Thai Capable): ตระกูล Qwen2.5 ถูกฝึกฝนมาให้รองรับหลายภาษา (Multilingual) และมีพื้นฐานภาษาไทยที่ดีกว่าโมเดลขนาด 3B ตัวอื่นๆ ในท้องตลาด (แม้จะยังมีหลอนบ้างถ้าเจาะลึกมากๆ จึงต้องใช้ Modelfile ช่วยตีกรอบ)⚠️ Problem (ปัญหา)เมื่อทดสอบถามคำถามเฉพาะทาง (เช่น "ต้อกระจกคืออะไร") ผ่าน API ตัวโมเดล qwen2.5:3b เกิดอาการ Hallucination (หลอนข้อมูล) อย่างหนัก โดยนำข้อมูลไปผสมกับ "คอนแทคเลนส์" และสร้างคำศัพท์ที่ไม่มีอยู่จริงขึ้นมาสาเหตุหลัก: ขนาดโมเดลเล็กเกินไปสำหรับภาษาไทยเฉพาะทาง, ไม่มี System Prompt ควบคุมทิศทาง และค่า Temperature เริ่มต้นอาจสูงเกินไป💡 Solution (วิธีแก้ปัญหา)ใช้วิธี Fine-Tuning แบบฉบับย่อด้วย Modelfile เพื่อสร้าง Custom Model โดยการ:กำหนด SYSTEM prompt เพื่อตีกรอบบทบาทและฝัง Domain Knowledge (ความรู้เฉพาะทาง) ลงไปถาวรปรับ PARAMETER temperature 0.1 เพื่อลดความสร้างสรรค์และบังคับให้ตอบตามข้อเท็จจริง🛠️ Execution Steps (ขั้นตอนการทำงานแบบพร้อมรัน)Step 1: สร้าง Modelfile เข้าไปใน Docker Container โดยตรงเพื่อป้องกันปัญหา "no Modelfile found" ให้ใช้คำสั่งเขียนไฟล์เข้าไปไว้ที่ /tmp/Modelfile ใน Container:docker exec -i ollama-e9cw-ollama-1 sh -c 'cat << "EOF" > /tmp/Modelfile
FROM qwen2.5:3b
PARAMETER temperature 0.1
SYSTEM "คุณคือผู้เชี่ยวชาญ คลังความรู้เฉพาะทางของคุณคือ: ต้อกระจก (Cataract) คือภาวะเลนส์ตาขุ่นมัวตามวัย รักษาด้วยการผ่าตัดเปลี่ยนเลนส์เทียม ห้ามตอบว่าต้อกระจกคือคอนแทคเลนส์เด็ดขาด"
EOF'
Step 2: สั่ง Build โมเดลตัวใหม่ (Custom Model)สร้างโมเดลชื่อ qwen2.5-expert จาก Modelfile ที่เพิ่งสร้าง:docker exec -it ollama-e9cw-ollama-1 ollama create qwen2.5-expert -f /tmp/Modelfile
Step 3: ทดสอบเรียกใช้งานผ่าน APIใช้ curl ยิงคำถามเดิมไปยังโมเดลตัวใหม่ (qwen2.5-expert):curl [http://72.62.252.196:32768/api/generate](http://72.62.252.196:32768/api/generate) -d "{\"model\": \"qwen2.5-expert\", \"prompt\": \"สรุปสั้นๆ ว่าต้อกระจกคืออะไร\", \"stream\": false}"
✅ Result (ผลลัพธ์)สถานะ: สำเร็จ (Success)คำตอบที่ได้: "ต้อกระจกเป็นภาวะที่เลนส์ตาขุ่นมัวตามความแก่ของผู้คน และสามารถรักษาด้วยการผ่าตัดเปลี่ยนเลนส์เทียม."ข้อสังเกต: โมเดลเลิกหลอน ตอบตรงตามความรู้เฉพาะทางที่ฝังไว้ (Domain Knowledge) และใช้เวลาประมวลผล (eval_duration) ลดลงอย่างมีนัยสำคัญเนื่องจากไม่ต้องสุ่มคำตอบ📋 คำสั่ง Ollama พื้นฐานที่ควรรู้ (Useful Commands)เมื่อรันผ่าน Docker ให้ใช้คำสั่งเหล่านี้เพื่อบริหารจัดการโมเดล:# ดูรายการโมเดลทั้งหมดที่มีอยู่ในเครื่อง
docker exec -it ollama-e9cw-ollama-1 ollama list

# ดาวน์โหลดโมเดลใหม่ (ตัวอย่าง: โหลด qwen2.5 ตัวเต็ม 7b)
docker exec -it ollama-e9cw-ollama-1 ollama pull qwen2.5:7b

# ลองคุยกับโมเดลผ่าน Command Line โดยตรง
docker exec -it ollama-e9cw-ollama-1 ollama run qwen2.5-expert

# ดูรายละเอียดและการตั้งค่าของโมเดล
docker exec -it ollama-e9cw-ollama-1 ollama show qwen2.5-expert

# ลบโมเดลที่ไม่ต้องการใช้เพื่อคืนพื้นที่
docker exec -it ollama-e9cw-ollama-1 ollama rm qwen2.5-expert
