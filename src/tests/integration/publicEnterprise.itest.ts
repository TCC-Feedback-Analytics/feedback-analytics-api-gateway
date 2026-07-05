import { describe, it, expect, afterAll } from 'vitest';
import {
  getPublicEnterpriseById,
  resolveQrCollectionPoint,
} from '../../repositories/publicEnterprise.repository.js';
import { closeDb } from '../../db/client.js';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000001';
const QR_GERAL_A = 'cccccccc-0000-0000-0000-0000000000aa';
const QR_GERAL_B = 'cccccccc-0000-0000-0000-0000000000bb';
const INEXISTENTE = 'dddddddd-0000-0000-0000-0000000000ff';

afterAll(async () => {
  await closeDb();
});

describe('[Integração] getPublicEnterpriseById — empresa pública via view', () => {
  it('A resolve id + name (full_name do gestor)', async () => {
    const ent = await getPublicEnterpriseById(A);
    expect(ent).not.toBeNull();
    expect(ent?.id).toBe(A);
    expect(ent?.name).toBe('Gestor A');
  });

  it('id inexistente => null', async () => {
    const ent = await getPublicEnterpriseById(INEXISTENTE);
    expect(ent).toBeNull();
  });
});

describe('[Integração] resolveQrCollectionPoint — ponto QR tenant-scoped + isolamento', () => {
  it('A escopo empresa (catalog_item_id NULL) => QR Geral A', async () => {
    const cp = await resolveQrCollectionPoint({ enterpriseId: A, catalogItemId: null });
    expect(cp).not.toBeNull();
    expect(cp?.id).toBe(QR_GERAL_A);
    expect(cp?.name).toBe('QR Geral A');
    expect(cp?.catalogItemId).toBeNull();
    expect(cp?.catalogItemName).toBeNull();
    expect(cp?.catalogItemKind).toBeNull();
  });

  it('A resolve por id do próprio ponto => QR Geral A', async () => {
    const cp = await resolveQrCollectionPoint({ enterpriseId: A, collectionPointId: QR_GERAL_A });
    expect(cp?.id).toBe(QR_GERAL_A);
  });

  it('ISOLAMENTO: A pedindo o ponto de B (por id) => null', async () => {
    const cp = await resolveQrCollectionPoint({ enterpriseId: A, collectionPointId: QR_GERAL_B });
    expect(cp).toBeNull();
  });

  it('ISOLAMENTO: B escopo empresa => QR Geral B (não vê o de A)', async () => {
    const cp = await resolveQrCollectionPoint({ enterpriseId: B, catalogItemId: null });
    expect(cp?.id).toBe(QR_GERAL_B);
    expect(cp?.name).toBe('QR Geral B');
  });
});
