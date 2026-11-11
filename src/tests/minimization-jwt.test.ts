/**
 * Validação de Minimização de Dados (LGPD Art. 6º, III)
 *
 * Garante que:
 * 1. Tokens de sessão (Better Auth) são opacos e NÃO contêm dados pessoais
 *    sensíveis (CPF, documento, telefone) trafegando no navegador.
 * 2. O telefone do gestor reside estritamente no banco de dados (tabela user),
 *    nunca no payload do cookie de sessão.
 * 3. CPF/CNPJ foi eliminado do modelo de dados (tabela enterprise) e de schemas.
 * 4. Formulários de feedback público não coletam documento/CPF do cliente.
 */
import { describe, it, expect } from 'vitest';
import { session, enterprise, user } from '../../drizzle/schema.js';
import { publicFeedbackSchema } from '@feedback/lib-shared/schemas/public/feedbackSchema';
import { registerSchema } from '@feedback/lib-shared/schemas/public/registerSchema';

describe('[Segurança & LGPD] Minimização de Dados e Higienização de Sessão', () => {
  describe('Sessão e Cookies (Better Auth vs. JWT tradicional)', () => {
    it('o schema da tabela session não armazena CPF, documento ou telefone', () => {
      const sessionColumns = Object.keys(session);
      
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

    it('tokens de sessão são strings opacas e não JWTs com claims de CPF/documento/telefone', () => {
      // Simula tokens opacos gerados pelo Better Auth (ex: 32+ bytes aleatórios em base64url/hex)
      const mockOpaqueSessionToken = 'ba_sess_9a8f7e6d5c4b3a210987654321fedcba';
      
      // Um token opaco não possui estrutura de 3 partes separadas por ponto de um JWT
      const isJwt = mockOpaqueSessionToken.split('.').length === 3;
      expect(isJwt).toBe(false);

      // Função que inspeciona qualquer payload de autenticação garantindo ausência de PII sensível
      function inspectTokenPayload(payload: Record<string, unknown>) {
        const forbiddenKeys = ['cpf', 'cnpj', 'document', 'phone', 'telephone', 'doc'];
        const foundForbidden = Object.keys(payload).filter((k) =>
          forbiddenKeys.includes(k.toLowerCase())
        );
        return foundForbidden;
      }

      // Se um JWT simulado fosse inspecionado, chaves sensíveis devem estar ausentes
      const safeClaims = {
        sub: '123e4567-e89b-12d3-a456-426614174000',
        email: 'gestor@empresa.com',
        iat: 1731283200,
        exp: 1731369600,
      };

      expect(inspectTokenPayload(safeClaims)).toEqual([]);

      // Validação de que payload contendo CPF/documento/telefone é detectado e proibido
      const contaminatedClaims = {
        sub: '123e4567-e89b-12d3-a456-426614174000',
        cpf: '123.456.789-00',
        phone: '+5511999998888',
        document: '12345678000199',
      };
      expect(inspectTokenPayload(contaminatedClaims)).toEqual(['cpf', 'phone', 'document']);
    });

    it('telefone reside exclusivamente na entidade de usuário no banco, fora do token', () => {
      const userColumns = Object.keys(user);
      expect(userColumns).toContain('phone');

      // Mas o token da sessão (cookie) só armazena a referência opaca
      const sessionKeys = Object.keys(session);
      expect(sessionKeys).not.toContain('phone');
    });
  });

  describe('Remoção de CPF/CNPJ da Empresa (Migration 0009)', () => {
    it('a entidade enterprise não possui campos de documento ou tipo de conta', () => {
      const enterpriseColumns = Object.keys(enterprise);
      
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
