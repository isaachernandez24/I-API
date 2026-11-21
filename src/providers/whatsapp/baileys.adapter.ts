import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WASocket
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { env } from '../../config/env.js';
import { prisma } from '../../config/prisma.js';
import { IMessageProvider, SendMessageOptions } from '../provider.interface.js';
import { usePostgresAuthState } from './postgres.auth.js';
import { disconnectAction, disconnectReasonName } from './disconnect-policy.js';
import { telegramAdapter } from '../telegram/telegram.adapter.js';
import { formatMessageContent } from '../../utils/message-format.js';
import { fetchSafeMedia } from '../../utils/safe-url.js';
import { dispatchWebhook } from '../../utils/webhook.js';

interface InstanceSession {
  socket: WASocket;
  status: 'CONNECTING' | 'QR_READY' | 'CONNECTED' | 'DISCONNECTED';
  qrBase64?: string;
  pairingCode?: string;
  phoneNumber?: string;
  reconnectAttempts: number;
  reconnectTimer?: NodeJS.Timeout;
}

const logger = pino({ level: 'silent' }) as unknown as NonNullable<
  Parameters<typeof makeWASocket>[0]['logger']
>;
const MAX_RECONNECT_ATTEMPTS = 12;

const randomInt = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

type ConnectResult = { status: string; qrBase64?: string; pairingCode?: string };

// Motor de WhatsApp Multi-Instancia con reconexión inteligente (backoff exponencial) y soporte QR / Pairing Code
export class WhatsAppAdapter implements IMessageProvider {
  private sessions = new Map<string, InstanceSession>();
  // Conexiones en curso por proyecto: las peticiones simultáneas comparten la misma en lugar de abrir otro socket
  private connecting = new Map<string, Promise<ConnectResult>>();
  private shuttingDown = false;

  // Inicia o recupera una sesión de WhatsApp para un proyecto (Tenant) sin duplicar sockets
  connectInstance(tenantId: string, phoneForPairingCode?: string, forceNewSocket = false): Promise<ConnectResult> {
    if (this.shuttingDown) {
      return Promise.resolve({ status: 'DISCONNECTED' });
    }

    const pending = this.connecting.get(tenantId);
    if (pending && !forceNewSocket) {
      return pending;
    }

    const attempt = this.openConnection(tenantId, phoneForPairingCode, forceNewSocket).finally(() => {
      if (this.connecting.get(tenantId) === attempt) this.connecting.delete(tenantId);
    });
    this.connecting.set(tenantId, attempt);
    return attempt;
  }

  // Desvincula el número: cierra la sesión en WhatsApp (el teléfono lo quita de "Dispositivos vinculados")
  // y borra las credenciales guardadas. La próxima conexión pedirá un QR nuevo.
  async logout(tenantId: string): Promise<{ status: string }> {
    const session = this.sessions.get(tenantId);
    this.connecting.delete(tenantId);
    this.sessions.delete(tenantId);

    if (session) {
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
      session.socket.ev.removeAllListeners('connection.update');
      session.socket.ev.removeAllListeners('creds.update');
      session.socket.ev.removeAllListeners('messages.upsert');
      session.socket.ev.removeAllListeners('messages.update');
      if (session.status === 'CONNECTED') {
        try {
          await session.socket.logout();
        } catch (err) {
          console.error(`[WhatsApp:${tenantId}] Error cerrando sesión en WhatsApp:`, err);
        }
      }
      try {
        session.socket.end(undefined);
      } catch {
        // Ignorar errores al cerrar
      }
    }

    await prisma.sessionCreds.deleteMany({ where: { tenantId, channel: 'WHATSAPP' } });
    console.log(`[WhatsApp:${tenantId}] Sesión desvinculada y credenciales eliminadas`);
    return { status: 'DISCONNECTED' };
  }

  // Cierra todos los sockets sin cerrar sesión en WhatsApp (las credenciales siguen en PostgreSQL)
  shutdown(): void {
    this.shuttingDown = true;
    for (const session of this.sessions.values()) {
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
      try {
        session.socket.ev.removeAllListeners('connection.update');
        session.socket.end(undefined);
      } catch {
        // Ignorar errores al cerrar
      }
    }
    this.sessions.clear();
  }

  private async openConnection(
    tenantId: string,
    phoneForPairingCode?: string,
    forceNewSocket = false
  ): Promise<ConnectResult> {
    const existing = this.sessions.get(tenantId);

    if (!forceNewSocket && existing && existing.status !== 'DISCONNECTED') {
      if (existing.status === 'CONNECTED') {
        return { status: 'CONNECTED' };
      }

      if (phoneForPairingCode && !existing.pairingCode && existing.status === 'QR_READY') {
        try {
          const cleanPhone = phoneForPairingCode.replace(/\D/g, '');
          existing.pairingCode = await existing.socket.requestPairingCode(cleanPhone);
        } catch (err) {
          console.error(`[WhatsApp:${tenantId}] Error generando Pairing Code:`, err);
        }
      }

      return {
        status: existing.status,
        qrBase64: existing.qrBase64,
        pairingCode: existing.pairingCode
      };
    }

    // Si había un socket anterior, cerrarlo limpiamente antes de crear uno nuevo
    if (existing) {
      if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
      try {
        existing.socket.ev.removeAllListeners('connection.update');
        existing.socket.ev.removeAllListeners('creds.update');
        existing.socket.ev.removeAllListeners('messages.upsert');
        existing.socket.ev.removeAllListeners('messages.update');
        existing.socket.end(undefined);
      } catch {
        // Ignorar errores al cerrar socket obsoleto
      }
    }

    const { state, saveCreds, clearSession } = await usePostgresAuthState(tenantId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: ['I-API Gateway', 'Chrome', '122.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      shouldIgnoreJid: (jid) => jid.endsWith('@broadcast') || jid.endsWith('@g.us'),
      getMessage: async () => undefined,
      cachedGroupMetadata: async () => undefined
    });

    const instanceState: InstanceSession = {
      socket: sock,
      status: 'CONNECTING',
      reconnectAttempts: existing?.reconnectAttempts || 0
    };
    this.sessions.set(tenantId, instanceState);

    sock.ev.on('creds.update', saveCreds);

    // Escucha de mensajes entrantes con webhook y auto-lectura opcional
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.key.fromMe && msg.key.remoteJid && msg.key.remoteJid !== 'status@broadcast') {
          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.documentMessage?.caption ||
            '';

          dispatchWebhook({
            event: 'message.received',
            tenantId,
            timestamp: new Date().toISOString(),
            data: {
              externalId: msg.key.id,
              from: msg.key.remoteJid,
              pushName: msg.pushName,
              text,
              messageTimestamp: msg.messageTimestamp
            }
          }).catch(() => {});

          if (env.autoReadMessages) {
            const readDelayMs = randomInt(3000, 8000);
            setTimeout(async () => {
              try {
                await sock.readMessages([msg.key]);
              } catch {
                // Ignorar si el socket se cerró durante la espera
              }
            }, readDelayMs);
          }
        }
      }
    });

    // Escucha de actualizaciones de estado (entrega, lectura, fallo)
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        if (!update.key.remoteJid || update.key.remoteJid === 'status@broadcast') continue;
        const statusMap: Record<number, string> = {
          0: 'FAILED',
          2: 'SERVER_ACK',
          3: 'DELIVERED',
          4: 'READ',
          5: 'PLAYED'
        };
        const statusName =
          typeof update.update.status === 'number' ? statusMap[update.update.status] : undefined;
        if (statusName) {
          dispatchWebhook({
            event: 'message.status',
            tenantId,
            timestamp: new Date().toISOString(),
            data: {
              externalId: update.key.id,
              recipient: update.key.remoteJid,
              fromMe: update.key.fromMe,
              status: statusName
            }
          }).catch(() => {});
        }
      }
    });

    // Promesa para capturar el primer QR o Pairing Code sin bloquear indefinidamente
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (data: { status: string; qrBase64?: string; pairingCode?: string }) => {
        if (!resolved) {
          resolved = true;
          resolve(data);
        }
      };

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          instanceState.status = 'QR_READY';
          instanceState.qrBase64 = await QRCode.toDataURL(qr);

          if (phoneForPairingCode && !state.creds.registered) {
            try {
              const cleanPhone = phoneForPairingCode.replace(/\D/g, '');
              instanceState.pairingCode = await sock.requestPairingCode(cleanPhone);
            } catch (err) {
              console.error(`[WhatsApp:${tenantId}] Error generando Pairing Code:`, err);
            }
          }

          finish({
            status: 'QR_READY',
            qrBase64: instanceState.qrBase64,
            pairingCode: instanceState.pairingCode
          });
        }

        if (connection === 'open') {
          instanceState.status = 'CONNECTED';
          instanceState.qrBase64 = undefined;
          instanceState.pairingCode = undefined;
          instanceState.reconnectAttempts = 0;
          instanceState.phoneNumber = sock.user?.id.split(':')[0];
          console.log(`[WhatsApp:${tenantId}] Sesión CONECTADA (${instanceState.phoneNumber})`);
          finish({ status: 'CONNECTED' });
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          const action = disconnectAction(statusCode);
          // Todo cierre queda en el registro con su código, aunque no haya alertas por Telegram
          console.warn(
            `[WhatsApp:${tenantId}] Conexión cerrada (code: ${statusCode ?? '-'}, ${disconnectReasonName(statusCode)}): ${action}${
              lastDisconnect?.error?.message ? ` | ${lastDisconnect.error.message}` : ''
            }`
          );

          // 1. El teléfono quitó el dispositivo (401) -> las credenciales ya no sirven: limpiar y alertar
          if (action === 'cerrar-sesion') {
            instanceState.status = 'DISCONNECTED';
            this.sessions.delete(tenantId);
            await clearSession();
            console.warn(`[WhatsApp:${tenantId}] Credenciales eliminadas: hay que vincular el número de nuevo`);
            await telegramAdapter.sendAdminAlert(
              `⚠️ [I-API] Sesión de WhatsApp (${tenantId}) cerrada desde el teléfono (code: ${statusCode}). Requiere revinculación.`
            );
            finish({ status: 'DISCONNECTED' });
            return;
          }

          // 2. Número restringido (403) o sesión reemplazada en otro lugar (440) -> NO reconectar en bucle
          if (action === 'detener') {
            instanceState.status = 'DISCONNECTED';
            await telegramAdapter.sendAdminAlert(
              `🚨 [I-API] Reconexión detenida para proyecto ${tenantId} (code: ${statusCode} - ${
                statusCode === DisconnectReason.forbidden ? 'Forbidden/Restringido' : 'Connection Replaced'
              }).`
            );
            finish({ status: 'DISCONNECTED' });
            return;
          }

          // 3. Reinicio requerido por WhatsApp tras emparejar (515) -> reconexión inmediata
          if (action === 'reiniciar') {
            console.log(`[WhatsApp:${tenantId}] Reinicio requerido tras vinculación (515), reconectando...`);
            instanceState.reconnectTimer = setTimeout(() => {
              this.connectInstance(tenantId, undefined, true).catch((e) =>
                console.error(`[WhatsApp:${tenantId}] Fallo en reconexión 515:`, e)
              );
            }, 1000);
            return;
          }

          // 4. Cualquier otro corte (red, 500, 411...) -> Backoff exponencial (4s, 8s, 16s... máx 5 min) con
          // límite de intentos. Las credenciales se conservan: al reiniciar el servidor se vuelve a intentar.
          instanceState.reconnectAttempts += 1;
          if (instanceState.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            instanceState.status = 'DISCONNECTED';
            console.warn(
              `[WhatsApp:${tenantId}] Reconexión detenida tras ${MAX_RECONNECT_ATTEMPTS} intentos (último code: ${statusCode ?? '-'})`
            );
            await telegramAdapter.sendAdminAlert(
              `⚠️ [I-API] Se alcanzó el límite de ${MAX_RECONNECT_ATTEMPTS} intentos de reconexión para ${tenantId} (último code: ${statusCode}).`
            );
            finish({ status: 'DISCONNECTED' });
            return;
          }

          const backoffMs = Math.min(4000 * Math.pow(2, instanceState.reconnectAttempts - 1), 300000);
          console.log(
            `[WhatsApp:${tenantId}] Reconectando en ${Math.round(backoffMs / 1000)}s (intento ${instanceState.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}, code: ${statusCode})...`
          );

          instanceState.reconnectTimer = setTimeout(() => {
            this.connectInstance(tenantId, undefined, true).catch((e) =>
              console.error(`[WhatsApp:${tenantId}] Fallo en reconexión:`, e)
            );
          }, backoffMs);
        }
      });

      setTimeout(() => {
        finish({
          status: instanceState.status,
          qrBase64: instanceState.qrBase64,
          pairingCode: instanceState.pairingCode
        });
      }, 6000);
    });
  }

  // Restaura automáticamente todas las sesiones guardadas en PostgreSQL al arrancar
  async restoreAllSessions(): Promise<void> {
    const savedTenants = await prisma.sessionCreds.findMany({
      where: { channel: 'WHATSAPP', keyId: 'creds' },
      select: { tenantId: true }
    });

    for (const { tenantId } of savedTenants) {
      console.log(`[WhatsApp] Restaurando sesión persistida para tenant: ${tenantId}`);
      this.connectInstance(tenantId).catch((err) =>
        console.error(`[WhatsApp:${tenantId}] Error restaurando sesión:`, err)
      );
    }
  }

  async getStatus(tenantId: string): Promise<{ status: string; details?: Record<string, unknown> }> {
    const session = this.sessions.get(tenantId);
    if (!session) {
      return { status: 'DISCONNECTED' };
    }
    return {
      status: session.status,
      details: {
        phoneNumber: session.phoneNumber,
        qrBase64: session.qrBase64,
        pairingCode: session.pairingCode
      }
    };
  }

  // Descarga el archivo indicado en mediaUrl justo antes de enviarlo (validación anti-SSRF en ese momento)
  private async downloadMedia(mediaUrl?: string): Promise<Buffer> {
    if (!mediaUrl) throw new Error('INVALID_MEDIA_URL: el mensaje no tiene mediaBase64 ni mediaUrl');
    if (!env.allowMediaUrl) throw new Error('INVALID_MEDIA_URL: mediaUrl está desactivado en este servidor');
    return fetchSafeMedia(mediaUrl);
  }

  // Envía mensaje o documento con tiempo de escritura proporcional
  async send(options: SendMessageOptions): Promise<{ externalId?: string }> {
    const { messageId, tenantId, recipient, type, payload } = options;
    const session = this.sessions.get(tenantId);

    if (!session || session.status !== 'CONNECTED') {
      throw new Error('SESSION_NOT_CONNECTED');
    }

    const cleanNumber = recipient.replace(/\D/g, '');
    const jid = recipient.includes('@') ? recipient : `${cleanNumber}@s.whatsapp.net`;
    await session.socket.presenceSubscribe(jid).catch(() => {});

    const shouldHumanize = payload.humanize ?? env.humanizeMessages;

    if (type === 'TEXT') {
      const finalText = formatMessageContent(payload.text, shouldHumanize, messageId);
      // Calcula tiempo de escritura humano (~50ms por carácter, acotado por FAST_TYPING_MIN_MS y FAST_TYPING_MAX_MS)
      const baseTypingMs = Math.min(
        Math.max(finalText.length * 50, env.fastTypingMinMs),
        env.fastTypingMaxMs
      );
      const typingMs = baseTypingMs + randomInt(200, 1100);

      await session.socket.sendPresenceUpdate('composing', jid);
      await new Promise((r) => setTimeout(r, typingMs));
      await session.socket.sendPresenceUpdate('paused', jid);

      const sent = await session.socket.sendMessage(jid, { text: finalText });
      return { externalId: sent?.key.id || undefined };
    }

    // Para archivos (PDF/Imagen): pausa corta de adjuntado sin fingir escritura larga
    await new Promise((r) => setTimeout(r, randomInt(1200, 2400)));
    const finalCaption =
      payload.caption || payload.text
        ? formatMessageContent(payload.caption || payload.text, shouldHumanize, messageId)
        : undefined;

    if (type === 'DOCUMENT') {
      const buffer = payload.mediaBase64
        ? Buffer.from(payload.mediaBase64, 'base64')
        : await this.downloadMedia(payload.mediaUrl);

      const sent = await session.socket.sendMessage(jid, {
        document: buffer,
        mimetype: payload.mimeType || 'application/pdf',
        fileName: payload.fileName || 'documento.pdf',
        caption: finalCaption
      });
      return { externalId: sent?.key.id || undefined };
    }

    if (type === 'IMAGE') {
      const buffer = payload.mediaBase64
        ? Buffer.from(payload.mediaBase64, 'base64')
        : await this.downloadMedia(payload.mediaUrl);

      const sent = await session.socket.sendMessage(jid, {
        image: buffer,
        caption: finalCaption
      });
      return { externalId: sent?.key.id || undefined };
    }

    throw new Error(`Tipo de mensaje no soportado: ${type}`);
  }
}

export const whatsappAdapter = new WhatsAppAdapter();
