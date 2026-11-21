import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disconnectAction, disconnectReasonName } from '../../src/providers/whatsapp/disconnect-policy.js';

test('solo el cierre desde el teléfono (401) borra la sesión', () => {
  assert.equal(disconnectAction(401), 'cerrar-sesion');
});

test('sesión dañada (500) y desajuste multidispositivo (411) reconectan con las credenciales guardadas', () => {
  assert.equal(disconnectAction(500), 'reconectar');
  assert.equal(disconnectAction(411), 'reconectar');
});

test('número restringido (403) y sesión en otro lugar (440) no reintentan', () => {
  assert.equal(disconnectAction(403), 'detener');
  assert.equal(disconnectAction(440), 'detener');
});

test('515 reinicia y los cortes de red o sin código reconectan', () => {
  assert.equal(disconnectAction(515), 'reiniciar');
  for (const code of [408, 428, 503, undefined, 999]) assert.equal(disconnectAction(code), 'reconectar', String(code));
});

test('el motivo del cierre se describe para el registro', () => {
  assert.equal(disconnectReasonName(500), 'sesión dañada');
  assert.equal(disconnectReasonName(undefined), 'sin código');
  assert.equal(disconnectReasonName(999), 'desconocido');
});
