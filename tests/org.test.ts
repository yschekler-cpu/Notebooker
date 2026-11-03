import { beforeEach, describe, expect, it } from "vitest";
import { installChromeMock } from "./chrome-mock";
import { exportOrganization, importOrganization } from "../src/shared/org";
import { getFolders, getNotebookMetas, saveFolders, upsertNotebookMeta } from "../src/shared/storage";

const NB = "11111111-2222-3333-4444-555555555555";
const F1 = "f1f1f1f1-0000-4000-8000-000000000001";

beforeEach(() => void installChromeMock());

describe("export / import de l'organisation", () => {
  it("aller-retour sans perte", async () => {
    await saveFolders([{ id: F1, name: "Conformité", color: "#dc2626", order: 0 }]);
    await upsertNotebookMeta(NB, { title: "KYC", folderId: F1, tags: ["kyc"], pinned: true });
    const dump = await exportOrganization();
    installChromeMock();
    expect(await importOrganization(JSON.parse(JSON.stringify(dump)))).toEqual({ folders: 1, notebooks: 1 });
    expect(await getFolders()).toEqual(dump.folders);
    expect((await getNotebookMetas())[NB]).toMatchObject({ folderId: F1, tags: ["kyc"], pinned: true });
  });

  it("rejette un fichier étranger et assainit les champs", async () => {
    await expect(importOrganization({ foo: 1 })).rejects.toThrow(/Format inconnu/);
    await importOrganization({
      format: "notebooker-org", version: 1, exportedAt: "",
      folders: [
        { id: F1, name: "<img onerror=x>", color: "red;background:url(x)", order: 0 },
        { id: "'><img src=x onerror=alert(1)>", name: "evil", color: "#fff", order: 1 },
      ],
      notebooks: [{ notebookId: "../../etc", title: "x" }, { notebookId: NB, title: "ok", folderId: "inconnu", tags: [1, "t"], pinned: "yes" }],
    });
    const fs = await getFolders();
    expect(fs).toHaveLength(1); // l'ID non-UUID (tentative d'injection) est rejeté
    expect(fs[0]!.color).toBe("#64748b");
    const metas = await getNotebookMetas();
    expect(Object.keys(metas)).toEqual([NB]);
    expect(metas[NB]).toMatchObject({ folderId: null, tags: ["t"], pinned: false });
  });
});
