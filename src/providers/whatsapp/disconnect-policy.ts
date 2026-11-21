import { DisconnectReason } from '@whiskeysockets/baileys';

// Qué hacer cuando WhatsApp cierra la conexión de una sesión.
// - cerrar-sesion: el teléfono quitó el dispositivo (401). Las credenciales ya no sirven y se borran.
// - detener: número restringido (403) o sesión abierta en otro lugar (440). No se reintenta en bucle.
// - reiniciar: WhatsApp pide reiniciar tras emparejar (515).
// - reconectar: cualquier otro corte, incluidos 500 (badSession) y 411. Se reintenta con las
//   credenciales guardadas, como recomienda Baileys: borrarlas obligaría a escanear un QR nuevo
//   por un error que suele ser pasajero.
export type DisconnectAction = 'cerrar-sesion' | 'detener' | 'reiniciar' | 'reconectar';

export function disconnectAction(statusCode: number | undefined): DisconnectAction {
  if (statusCode === DisconnectReason.loggedOut) return 'cerrar-sesion';
  if (statusCode === DisconnectReason.forbidden || statusCode === DisconnectReason.connectionReplaced) {
    return 'detener';
  }
  if (statusCode === DisconnectReason.restartRequired) return 'reiniciar';
  return 'reconectar';
}

const REASON_NAMES: Record<number, string> = {
  [DisconnectReason.loggedOut]: 'sesión cerrada desde el teléfono',
  [DisconnectReason.badSession]: 'sesión dañada',
  [DisconnectReason.multideviceMismatch]: 'desajuste multidispositivo',
  [DisconnectReason.forbidden]: 'número restringido',
  [DisconnectReason.connectionReplaced]: 'sesión abierta en otro lugar',
  [DisconnectReason.restartRequired]: 'reinicio requerido',
  [DisconnectReason.connectionClosed]: 'conexión cerrada',
  [DisconnectReason.connectionLost]: 'conexión perdida o tiempo agotado',
  [DisconnectReason.unavailableService]: 'servicio no disponible'
};

export function disconnectReasonName(statusCode: number | undefined): string {
  if (statusCode === undefined) return 'sin código';
  return REASON_NAMES[statusCode] ?? 'desconocido';
}
