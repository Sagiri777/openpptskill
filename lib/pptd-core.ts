/** TypeScript surface for the dependency-free local PPTD runtime. */
export type Color = string;
export type Bounds = [number, number, number, number];
export interface PptdElement { elementId?: string; elementType?: string; bounds?: Bounds; [key: string]: unknown; }
export interface PptdPage { pageType?: string; elements?: PptdElement[]; [key: string]: unknown; }
export interface PptdManifest { version: string; title?: string; size?: [number, number]; pages: string[]; theme?: Record<string, unknown>; [key: string]: unknown; }
export interface PptdProject { root: string; manifestPath: string; manifestSource: string; manifest: PptdManifest; pages: Array<{ path: string; absolutePath: string; source: string; data: PptdPage; index: number }>; size: [number, number]; title: string; }
export { parseYaml, stringifyYaml, parseYamlCst, setYamlCst, updateYamlCst, stringifyYamlCst, latexToOmml, ECMA_PRESET_GEOMETRIES, PRESET_SHAPE_NAMES, SHAPE_ADJUSTMENTS, SHAPE_ADJUSTMENT_NAMES, resolveColor, findManifest, loadProject, validateProject, renderPageSvg, resolveProjectResource, exportPptx, makeZip, sha256, fontEmbeddingPolicy, verifyOoxmlEntries } from "./pptd-core.js";
