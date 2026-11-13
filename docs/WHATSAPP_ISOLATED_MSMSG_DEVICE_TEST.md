# Tezlify WhatsApp — İzole Laboratuvarda Gerçek Cihaz `msmsg` Test Prosedürü

Bu doküman, production WhatsApp oturumuna, veritabanına, sunucusuna veya gizli anahtarlarına dokunmadan, gerçek bir WhatsApp mobil istemcisinden gelen `MESSAGE_EDIT` (`enc type="msmsg"`) davranışını izole ortamda gözlemlemek için adım adım prosedürü tanımlar.

---

## 1. Test Hesabı ve Ayrı Telefon Gereksinimleri

- **Production hesabı kesinlikle kullanılmaz.** İşletme/müşteri yazışmalarının bulunduğu ana WhatsApp hattını bu ortama bağlamayın.
- Yalnızca test amacıyla ayrılmış **ikincil bir WhatsApp test numarası** (ve tercihen ayrı bir test telefonu) kullanın.
- Mesaj düzenleme testi için ayrı bir hedef sohbet (ör. ikinci bir test numarası veya Note-to-Self olmayan ayrı bir test alıcısı ve ayrı olarak ses/alıntı/metin testleri) hazırlayın.
- Tüm ağ/container/oturum yapılandırması `docker-compose.wa-isolated-test.yml` üzerinden çalışır; varsayılan `WHATSAPP_AUTO_RESTORE="false"` ayarı sayesinde başlangıçta hiçbir mevcut oturum geri yüklenmez veya QR otomatik başlatılmaz.

---

## 2. İzole Laboratuvarın Nasıl Başlatılacağı

1. Ortam şablonunu kopyalayın (`.env.wa-test` Git'e eklenmez):
   ```bash
   cp scripts/wa_isolated_test/.env.wa-test.example scripts/wa_isolated_test/.env.wa-test
   ```
2. Başlatma öncesi izolasyon doğrulamasını çalıştırın (read-only):
   ```bash
   bash scripts/wa_isolated_test/run-isolated-lab.sh verify-isolation
   ```
3. Yalnızca izole stack'i (`tezlify-wa-isolated`) başlatın:
   - Standart başlatma (wire capture **KAPALI**):
     ```bash
     bash scripts/wa_isolated_test/run-isolated-lab.sh up
     ```
   - Veya aktif `msmsg` gözlemi için (wire capture açık, aşağıda Bölüm 5):
     ```bash
     bash scripts/wa_isolated_test/run-isolated-lab.sh up-capture
     ```
4. `run-isolated-lab.sh` başlatmadan önce `.env.wa-test` içindeki placeholder'ların değiştirildiğini ve `GATEWAY_ENCRYPTION_KEY`'in (varsa) `.env.production` ile aynı olmadığını doğrular.
5. Servisler yalnızca loopback adreslerinde dinler:
   - İzole Backend: `http://127.0.0.1:18000`
   - İzole Gateway: `http://127.0.0.1:18787`

---

## 3. Test Encryption Key ve Secret Oluşturma Yöntemi

`.env.wa-test` içindeki tüm placeholder değerleri **yalnızca test ortamına özel**, production/staging anahtarlarından tamamen bağımsız rastgele değerlerle doldurun:

```bash
# Her değişken için ayrı ayrı 64 hex karakterlik güçlü anahtar üretin:
openssl rand -hex 32   # WA_ISOLATED_DB_PASSWORD (veya güçlü parola)
openssl rand -hex 32   # GATEWAY_ENCRYPTION_KEY
openssl rand -hex 32   # WHATSAPP_GATEWAY_SECRET
openssl rand -hex 32   # JWT_SECRET
```

- `0000...`, `aaaa...`, `replace-with-...` gibi zayıf/placeholder anahtarlar kullanmayın (`message-secret-store.js` production'da ve strict modda bunları reddeder).
- Herhangi bir production `.env.production`, `.env.backend` veya `.env.staging` sırrını kopyalamayın.

---

## 4. QR Kodun Nereden Görüntüleneceği

İzole Gateway başlatıldığında otomatik oturum oluşturmaz veya QR üretmez. Test oturumunu manuel açmak için:

1. Yeni bir izole test oturumu başlatın (`WHATSAPP_GATEWAY_SECRET` ile kimlik doğrulamalı):
   ```bash
   curl -sS -X POST "http://127.0.0.1:18787/sessions" \
     -H "Authorization: Bearer <TEST_WHATSAPP_GATEWAY_SECRET>" \
     -H "Content-Type: application/json" \
     -d '{"session_name": "wa-protocol-lab-isolated"}'
   ```
2. Dönen `<SESSION_ID>` ile QR verisini alın:
   ```bash
   curl -sS "http://127.0.0.1:18787/sessions/<SESSION_ID>/qr" \
     -H "Authorization: Bearer <TEST_WHATSAPP_GATEWAY_SECRET>"
   ```
   Alternatif olarak yalnızca loopback'te çalışan izole backend/API veya dönen `data:image/png;base64,...` QR URI'sini tarayıcıda görüntüleyip test telefonunuzdaki WhatsApp (`Bağlı Cihazlar -> Cihaz Bağla`) üzerinden taratın.
3. Bağlantı durumunu ve `secret_persistence_state` bilgisini kontrol edin:
   ```bash
   curl -sS "http://127.0.0.1:18787/sessions/<SESSION_ID>" \
     -H "Authorization: Bearer <TEST_WHATSAPP_GATEWAY_SECRET>"
   ```

---

## 5. Capture'ın Nasıl Açıkça Etkinleştirileceği

- Varsayılan olarak hem compose dosyasında (`WA_ISOLATED_WIRE_CAPTURE=false`) hem de `msmsg-wire-capture.js` modülünde wire capture **KAPALI**dır.
- Production runtime'da (`NODE_ENV=production` veya `APP_ENV=production`) capture modülü fail-closed olarak tamamen engellenir.
- İzole laboratuvarda **yalnızca maskelenmiş protokol metadata capture** açmak için:
  ```bash
  bash scripts/wa_isolated_test/run-isolated-lab.sh up-capture
  ```
  (Arka planda `WA_ISOLATED_WIRE_CAPTURE=true` ve `WA_ISOLATED_CAPTURE_CIPHERTEXT=false` geçirir; `wa-isolated-gateway` ise `NODE_ENV: development` olarak çalışır.)
- Ham şifreli payload baytlarının (`ciphertext_only_b64`) yalnızca kısa süreli lokal protokol analizi için geçici olarak yakalanması gerekirse operatör açıkça `WA_ISOLATED_CAPTURE_CIPHERTEXT=true` set ederek başlatabilir; plaintext gövde veya `messageSecret` loglara yine yazılmaz.

---

## 6. Test Mesajı Gönderme ve Düzenleme Adımları

1. İzole Gateway loglarını izleyin:
   ```bash
   docker compose --project-name tezlify-wa-isolated -f docker-compose.wa-isolated-test.yml logs -f wa-isolated-gateway
   ```
2. Test telefonundaki WhatsApp uygulamasından hedef test sohbetine kısa bir metin mesajı gönderin (ör. `Test1`).
3. Gateway'in mesajı aldığını ve (varsa) `messageSecret` kaydını oluşturduğunu log/health üzerinden doğrulayın (`http://127.0.0.1:18787/health` içindeki `message_secret_storage.ram_size` sayacını kontrol edebilirsiniz).
4. Test telefonundan aynı mesajı birkaç saniye sonra düzenleyin (ör. `Test1` -> `Test2`).
5. Aşağıdakileri gözlemleyip test notuna kaydedin:
   - Gateway `CB:message` üzerinde `msmsg_stanza_observed` diagnostik olayı üretti mi? (`enc type="msmsg"` görüldü mü?)
   - Baileys bu paketi düşürdü mü (`baileys_handled: false`) yoksa `messages.upsert` / `messages.update` tetiklendi mi?
   - `secret_encrypted_edit_attempt`, `message_edit_ingested` veya outbox / WS `message_update` edit olayı üretildi mi?

---

## 7. Hangi Metadata'nın Toplanacağı

Test sırasında yalnızca PII/secret içermeyen şu yapısal telemetri alanları toplanır ve kaydedilir:
- `captured_at`, `session_ref` (maskeli oturum özeti)
- `node_tag`, `stanza_type`, `from_kind`, `to_kind` (`PN` / `LID` vb.; gerçek numara veya JID toplanmaz)
- `has_edit_attr`
- `enc_children` (yalnızca izinli attribute'lar: `type`, `v`, `count`, `mediatype` ve `byte_length`)
- `protobuf_decode_outcome`, `packet_kind` (`secret_enc_*`), `redacted_target_id`
- `secret_matched`, `decrypt_outcome`
- Edit olayının Gateway outbox / `/ws/gateway` katmanında üretilip üretilmediği (`message_edit_ingested`, `edit_metrics`).

Gerçek telefon numaraları, JID'ler, mesaj gövdeleri ve `messageSecret` ham değerleri raporlara kesinlikle yazılmaz.

---

## 8. Capture Dosyalarının Konumu, İzinleri ve Saklama Süresi

- **Konum:** `wa-isolated-gateway` container'ı içinde `GATEWAY_WIRE_CAPTURE_DIR: /tmp/tezlify-wa-capture` (container yaşam döngüsüne bağlı geçici `/tmp` dizini; kalıcı volume ve host bind-mount kullanılmaz).
- **Dosya/Dizin İzinleri:** `msmsg-wire-capture.js` capture dizinini `0o700`, üretilen `msmsg-<timestamp>-<rand>.json` dosyalarını `0o600` izinleriyle yazar; maksimum `100` dosya sınırı uygular.
- **Saklama Süresi (TTL):** Varsayılan `GATEWAY_WIRE_CAPTURE_TTL_MINUTES=30` (30 dakika). Süresi dolan artefaktlar yeni kayıtta veya `purgeExpired()` çağrısında otomatik silinir.
- Capture incelemesi yalnızca test tamamlanana kadar izole container içinden yapılır; kalıcı host arşivine kopyalanmaz.

---

## 9. Test Tamamlandıktan Sonra Capture ve Session Verilerinin Güvenli Temizliği

Test bittiğinde sırayla şu temizlik adımlarını çalıştırın:

1. Test telefonundaki WhatsApp (`Bağlı Cihazlar`) üzerinden test bağlantısını kapatın veya izole Gateway'den oturumu logout edin:
   ```bash
   curl -sS -X DELETE "http://127.0.0.1:18787/sessions/<SESSION_ID>" \
     -H "Authorization: Bearer <TEST_WHATSAPP_GATEWAY_SECRET>"
   ```
2. Geçici wire capture artefaktlarını silin:
   ```bash
   bash scripts/wa_isolated_test/run-isolated-lab.sh purge-capture
   ```
3. Yalnızca izole stack container ve test volume'larını durdurup temizleyin:
   ```bash
   bash scripts/wa_isolated_test/run-isolated-lab.sh down-wipe-test
   ```
4. Yerel `.env.wa-test` dosyasını kaldırın:
   ```bash
   rm -f scripts/wa_isolated_test/.env.wa-test
   ```

---

## 10. Production WhatsApp Hesabına ve Session'ına Dokunulmadığının Doğrulanması

1. **Çalışan Compose projesi ayrımı:** Tüm işlemler yalnızca `--project-name tezlify-wa-isolated` ve `docker-compose.wa-isolated-test.yml` ile yapılır; `tezlify-gateway`, `tezlify-backend`, `tezlify-caddy` isimlerine veya `docker-compose.prod.yml` / `docker-compose.staging.yml` dosyalarına dokunulmaz.
2. **İzolasyon doğrulaması:**
   ```bash
   bash scripts/wa_isolated_test/verify-isolation.sh
   ```
   Bu kontrol; production host yolları (`/opt/tezlify`, `/var/run/docker.sock`), production volume'ları (`whatsapp_sessions`, `whatsapp_media`, `tezlify_db`), `.env.production` ve `172.29.0.0/16` / `172.30.0.0/16` ağlarına referans olmadığını doğrular.
3. **Production hesap kontrolü:** Production telefonundaki WhatsApp `Bağlı Cihazlar` listesinde oturum sayısı/kimliği değişmemiş olmalı ve Tezlify canlı API/panel (`/health`) mevcut oturumu kesintisiz raporlamalıdır.

