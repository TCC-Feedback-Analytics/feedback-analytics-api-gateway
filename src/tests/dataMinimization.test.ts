/**
 * Validação de Minimização de Dados (LGPD Art. 6º, III)
 *
 * Garante que:
 * 1. O cookie de sessão (Better Auth) leva só o token da sessão, sem dados
 *    pessoais: a sessão mora no banco e não há JWT nem cache da sessão no cookie.
 * 2. O telefone do gestor fica na tabela `user`, nunca na tabela `session`.
 * 3. CPF/CNPJ foi eliminado do modelo de dados (tabela enterprise) e de schemas.
 * 4. Formulários de feedback público não coletam documento/CPF do cliente.
 */
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import type { BetterAuthOptions } from 'better-auth';
import { session, enterprise, user } from '../../drizzle/schema.js';
import { getAuth } from '../auth/auth.js';
import { publicFeedbackSchema } from '@feedback/lib-shared/schemas/public/feedbackSchema';
import { registerSchema } from '@feedback/lib-shared/schemas/public/registerSchema';

describe('[Segurança & LGPD] Minimização de Dados e Higienização de Sessão', () => {
  describe('Sessão e Cookies (Better Auth)', () => {
    it('o schema da tabela session não armazena CPF, documento ou telefone', () => {
      const sessionColumns = Object.keys(getTableColumns(session));

      expect(sessionColumns).not.toContain('cpf');
      expect(sessionColumns).not.toContain('cnpj');
      expect(sessionColumns).not.toContain('document');
      expect(sessionColumns).not.toContain('phone');
      expect(sessionColumns).not.toContain('user_phone');

      // A sessão persiste apenas identificadores técnicos essenciais
      expect(sessionColumns).toContain('token');
      expect(sessionColumns).toContain('userId');
      expect(sessionColumns).toContain('expiresAt');
    });

    it('o cookie de sessão leva só o token: sem cache da sessão no cookie nem plugin de JWT', () => {
      // Tipada como as opções gerais: o que a config não define vem `undefined`.
      const options: BetterAuthOptions = getAuth().options;

      // Com o cookieCache ligado, o Better Auth gravaria a sessão e o usuário
      // (com o telefone) num cookie do navegador.
      expect(options.session?.cookieCache?.enabled ?? false).toBe(false);

      // O plugin de JWT emitiria tokens com os dados do usuário.
      const pluginIds = (options.plugins ?? []).map((plugin) => plugin.id);
      expect(pluginIds).not.toContain('jwt');
    });

    it('telefone fica na tabela user, fora da tabela session', () => {
      expect(Object.keys(getTableColumns(user))).toContain('phone');
      expect(Object.keys(getTableColumns(session))).not.toContain('phone');
    });
  });

  describe('Remoção de CPF/CNPJ da Empresa (Migration 0009)', () => {
    it('a entidade enterprise não possui campos de documento ou tipo de conta', () => {
      const enterpriseColumns = Object.keys(getTableColumns(enterprise));

      // Conforme migration 0009_remove_enterprise_document.sql
      expect(enterpriseColumns).not.toContain('document');
      expect(enterpriseColumns).not.toContain('account_type');
      expect(enterpriseColumns).not.toContain('cpf');
      expect(enterpriseColumns).not.toContain('cnpj');
    });
  });

  describe('Minimização no Formulário Público de Feedback (Cliente Final)', () => {
    it('o schema público de feedback não solicita nem aceita CPF ou documento', () => {
      const shape = publicFeedbackSchema.shape;
      const keys = Object.keys(shape);

      expect(keys).not.toContain('cpf');
      expect(keys).not.toContain('cnpj');
      expect(keys).not.toContain('document');
      expect(keys).not.toContain('customer_cpf');
      expect(keys).not.toContain('customer_document');

      // O formulário aceita nota, comentário e respostas, com dados de identificação opcionais
      expect(keys).toContain('rating');
      expect(keys).toContain('message');
      expect(keys).toContain('answers');
    });

    it('rejeita ou ignora propriedades não autorizadas de documento em submissões públicas', () => {
      const payloadWithDoc = {
        enterprise_id: 'a0000000-0000-4000-8000-000000000000',
        rating: 5,
        message: 'Excelente atendimento!',
        answers: [],
        cpf: '123.456.789-00',
        document: '333.222.111-00',
      };

      const parsed = publicFeedbackSchema.safeParse(payloadWithDoc);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        // Zod faz strip de campos desconhecidos: cpf e document não persistem no objeto parseado
        expect((parsed.data as Record<string, unknown>).cpf).toBeUndefined();
        expect((parsed.data as Record<string, unknown>).document).toBeUndefined();
      }
    });
  });

  describe('Minimização no Cadastro de Gestores', () => {
    it('o cadastro de gestores não exige CPF ou CNPJ', () => {
      const shape = registerSchema.shape;
      const keys = Object.keys(shape);

      expect(keys).not.toContain('cpf');
      expect(keys).not.toContain('cnpj');
      expect(keys).not.toContain('document');
    });
  });
});
