import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import app from '../../../index.js';
import { getAuth } from '../../auth/auth.js';
import { getDb, closeDb } from '../../db/client.js';
import { provisionEnterpriseForUser } from '../../auth/enterpriseOnSignup.js';

/**
 * Cria um gestor completo em modo Better Auth: signUpEmail (user + account bcrypt),
 * provisiona a empresa (+3 perguntas COMPANY), marca o e-mail como verificado
 * (atalho do teste — pula o clique no link) e faz signInEmail p/ obter o cookie
 * de sessão. Retorna { userId, cookie } pronto para os requests protegidos.
 */
async function createManager(input: {
  email: string;
  password: string;
  name: string;
  phone: string;
  document: string;
  accountType: 'CPF' | 'CNPJ';
}): Promise<{ userId: string; cookie: string }> {
  const signUp = await getAuth().api.signUpEmail({
    body: { email: input.email, password: input.password, name: input.name, phone: input.phone },
  });
  const userId = (signUp.user as { id: string }).id;

  await provisionEnterpriseForUser(userId, {
    accountType: input.accountType,
    document: input.document,
    termsVersion: 'v1',
    termsAcceptedAt: new Date().toISOString(),
  });

  // Atalho de teste: verifica o e-mail direto (o fluxo real clica no link do Mailpit).
  await getDb().execute(sql`UPDATE public."user" SET email_verified = true WHERE id = ${userId}`);

  const signIn = await getAuth().api.signInEmail({
    body: { email: input.email, password: input.password },
    asResponse: true,
  });
  const setCookies = signIn.headers.getSetCookie();
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('signInEmail não retornou cookie de sessão');

  return { userId, cookie };
}

const A = {
  email: 'e2e-a@x.local',
  password: 'senha-super-secreta-a1',
  name: 'Gestor E2E A',
  phone: '+5511900000001',
  document: 'E2E-DOC-AAA',
  accountType: 'CNPJ' as const,
};
const B = {
  email: 'e2e-b@x.local',
  password: 'senha-super-secreta-b2',
  name: 'Gestor E2E B',
  phone: '+5511900000002',
  document: 'E2E-DOC-BBB',
  accountType: 'CNPJ' as const,
};

// Usuário criado SEM verificar o e-mail (para o caso RNE-014 no login).
const UNVERIFIED = { email: 'e2e-unverified@x.local', password: 'senha-unverified-9', phone: '+5511900000009' };
// CNPJ válido só-dígitos (o registerSchema exige /^\d{14}$/) e NÃO cadastrado —
// usado nos testes HTTP de register que retornam antes do insert (dup e-mail/telefone).
const VALID_CNPJ = '11222333000181';

let userIdA = '';
let userIdB = '';
let cookieA = '';
let cookieB = '';

beforeAll(async () => {
  ({ userId: userIdA, cookie: cookieA } = await createManager(A));
  ({ userId: userIdB, cookie: cookieB } = await createManager(B));
});

afterAll(async () => {
  const db = getDb();
  // Limpeza EXPLÍCITA (sem depender de ON DELETE CASCADE): filhos → empresa → user.
  for (const doc of [A.document, B.document]) {
    await db.execute(sql`DELETE FROM public.feedback_question_subquestions WHERE question_id IN (SELECT id FROM public.questions_of_feedbacks WHERE enterprise_id IN (SELECT id FROM public.enterprise WHERE document = ${doc}))`);
    await db.execute(sql`DELETE FROM public.questions_of_feedbacks WHERE enterprise_id IN (SELECT id FROM public.enterprise WHERE document = ${doc})`);
    await db.execute(sql`DELETE FROM public.collection_points WHERE enterprise_id IN (SELECT id FROM public.enterprise WHERE document = ${doc})`);
    await db.execute(sql`DELETE FROM public.catalog_items WHERE enterprise_id IN (SELECT id FROM public.enterprise WHERE document = ${doc})`);
    await db.execute(sql`DELETE FROM public.collecting_data_enterprise WHERE enterprise_id IN (SELECT id FROM public.enterprise WHERE document = ${doc})`);
    await db.execute(sql`DELETE FROM public.enterprise WHERE document = ${doc}`);
  }
  for (const email of [A.email, B.email, UNVERIFIED.email]) {
    await db.execute(sql`DELETE FROM public.session WHERE user_id IN (SELECT id FROM public."user" WHERE lower(email) = lower(${email}))`);
    await db.execute(sql`DELETE FROM public.account WHERE user_id IN (SELECT id FROM public."user" WHERE lower(email) = lower(${email}))`);
    await db.execute(sql`DELETE FROM public."user" WHERE lower(email) = lower(${email})`);
    await db.execute(sql`DELETE FROM public.verification WHERE identifier = ${email}`);
  }
  await closeDb();
});

describe('[E2E cutover] autenticação Better Auth + dados protegidos via HTTP', () => {
  it('bloqueia acesso sem sessão (401)', async () => {
    const res = await request(app).get('/api/protected/user/enterprise');
    expect(res.status).toBe(401);
  });

  it('gestor autenticado lê a PRÓPRIA empresa (sessão → enterpriseId → Drizzle)', async () => {
    const res = await request(app).get('/api/protected/user/enterprise').set('Cookie', cookieA);
    expect(res.status).toBe(200);
    expect(res.body.enterprise?.document).toBe(A.document);
    expect(res.body.user?.id).toBe(userIdA);
  });

  it('ISOLAMENTO: cada gestor vê apenas a sua empresa', async () => {
    const resB = await request(app).get('/api/protected/user/enterprise').set('Cookie', cookieB);
    expect(resB.status).toBe(200);
    expect(resB.body.user?.id).toBe(userIdB);
    expect(resB.body.enterprise?.document).toBe(B.document);
    expect(resB.body.enterprise?.document).not.toBe(A.document);
  });

  it('collecting_data: write + read + isolamento via req.enterpriseId (resolvido no middleware)', async () => {
    // Empresa recém-criada ainda não tem dados de coleta.
    const empty = await request(app).get('/api/protected/user/collecting_data').set('Cookie', cookieA);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ collecting: null });

    // Estes endpoints resolvem a empresa por `req.enterpriseId` (setado no
    // requireAuthBetter). Grava e relê — prova sessão → enterpriseId → Drizzle (tx).
    const patch = await request(app)
      .patch('/api/protected/user/collecting_data')
      .set('Cookie', cookieA)
      .send({ company_objective: 'Objetivo E2E A' });
    expect(patch.status).toBe(200);

    const after = await request(app).get('/api/protected/user/collecting_data').set('Cookie', cookieA);
    expect(after.body.collecting?.company_objective).toBe('Objetivo E2E A');

    // B não enxerga os dados de A (isolamento por enterpriseId).
    const collectingB = await request(app).get('/api/protected/user/collecting_data').set('Cookie', cookieB);
    expect(collectingB.body).toEqual({ collecting: null });

    const qr = await request(app).get('/api/protected/user/collection-points/qr/status').set('Cookie', cookieA);
    expect(qr.status).toBe(200);
    expect(qr.body.active).toBe(false);
  });

  it('WRITE ponta-a-ponta: habilitar o QR reflete no status, isolado por tenant', async () => {
    const enable = await request(app).post('/api/protected/user/collection-points/qr/enable').set('Cookie', cookieA).send({});
    expect(enable.status).toBe(200);
    expect(enable.body.active).toBe(true);
    expect(enable.body.id).toBeTruthy();

    const statusA = await request(app).get('/api/protected/user/collection-points/qr/status').set('Cookie', cookieA);
    expect(statusA.body.active).toBe(true);
    expect(statusA.body.id).toBe(enable.body.id);

    // O QR de B continua inativo — a escrita de A não vazou.
    const statusB = await request(app).get('/api/protected/user/collection-points/qr/status').set('Cookie', cookieB);
    expect(statusB.body.active).toBe(false);
  });
});

// Cobertura HTTP dos controllers de auth (loginController/logoutController/
// registerUserController), que substituem os antigos testes unitários mockando
// Supabase — aqui contra o Better Auth REAL.
describe('[E2E cutover] endpoints públicos de auth via HTTP', () => {
  it('POST /public/auth/login com credenciais válidas → 200 + cookie', async () => {
    const res = await request(app).post('/api/public/auth/login').send({ email: A.email, password: A.password });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user?.id).toBe(userIdA);
    expect(res.headers['set-cookie']).toBeTruthy();
  });

  it('POST /public/auth/login com senha errada → 401 code invalid_credentials', async () => {
    const res = await request(app).post('/api/public/auth/login').send({ email: A.email, password: 'senha-totalmente-errada' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('[RNE-014] login com e-mail NÃO verificado responde igual a credencial inválida (anti-enumeração)', async () => {
    // Cria um usuário e NÃO verifica o e-mail → requireEmailVerification bloqueia o login.
    await getAuth().api.signUpEmail({
      body: { email: UNVERIFIED.email, password: UNVERIFIED.password, name: 'Não Verificado', phone: UNVERIFIED.phone },
    });

    const res = await request(app).post('/api/public/auth/login').send({ email: UNVERIFIED.email, password: UNVERIFIED.password });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
    // NÃO pode vazar que a conta existe / está só não-confirmada.
    const bodyStr = JSON.stringify(res.body).toLowerCase();
    expect(bodyStr).not.toContain('confirm');
    expect(bodyStr).not.toContain('verificad');
  });

  it('POST /public/auth/login com payload inválido → 400', async () => {
    const res = await request(app).post('/api/public/auth/login').send({ email: 'nao-eh-email', password: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
  });

  it('register com e-mail já cadastrado → 200 confirmation_required (anti-enumeração)', async () => {
    const res = await request(app).post('/api/public/auth/register').send({
      email: A.email, // já existe
      password: 'SenhaForte123', confirmPassword: 'SenhaForte123', terms: true,
      accountType: 'CNPJ', fullName: 'Outro Gestor', phone: '+5562999990099', document: VALID_CNPJ,
    });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('confirmation_required');
  });

  it('register com telefone já cadastrado → 409 phone_taken', async () => {
    const res = await request(app).post('/api/public/auth/register').send({
      email: 'reg-novo@x.local',
      password: 'SenhaForte123', confirmPassword: 'SenhaForte123', terms: true,
      accountType: 'CNPJ', fullName: 'Outro Gestor', phone: A.phone /* já existe */, document: VALID_CNPJ,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('phone_taken');
  });

  it('POST /public/auth/register com payload inválido → 400', async () => {
    const res = await request(app).post('/api/public/auth/register').send({ email: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
  });

  it('forgot-password sempre responde 200 (anti-enumeração)', async () => {
    const res = await request(app).post('/api/public/auth/forgot-password').send({ email: A.email });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('forgot-password com e-mail inválido → 400', async () => {
    const res = await request(app).post('/api/public/auth/forgot-password').send({ email: 'nao-eh-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
  });

  it('resend-confirmation com e-mail inválido → 400', async () => {
    const res = await request(app).post('/api/public/auth/resend-confirmation').send({ email: 'nao-eh-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
  });

  it('POST /public/auth/logout → 204', async () => {
    const res = await request(app).post('/api/public/auth/logout').set('Cookie', cookieB).send({});
    expect(res.status).toBe(204);
  });
});
