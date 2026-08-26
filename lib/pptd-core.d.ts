export type Color = string;
export type Bounds = [number, number, number, number];
export type FontFamily = string | { latin: string; ea: string; cs?: string };
export type Alignment = ["left" | "center" | "right" | "justify" | "distributed", "top" | "middle" | "bottom"];
export type LineStyle = "solid" | "dash" | "dot";

export interface Border { style?: LineStyle; width?: number; color?: Color; }
export type BorderSpec = null | Border | [Border | null, Border | null] | [Border | null, Border | null, Border | null, Border | null];
export interface Shadow { blur: number; color: Color; offset?: [number, number]; }
export interface ColorStop { position: number; color: Color; }
export interface ImageFit { mode: "fill" | "contain" | "cover"; }
export interface ImageCrop { left?: number; top?: number; right?: number; bottom?: number; }
export interface SolidFill { type: "solid"; color: Color; }
export interface GradientFill { type: "gradient"; gradientType?: "linear" | "radial"; stops: ColorStop[]; angle?: number; }
export interface ImageFill { type: "image"; src: string; fit?: ImageFit; crop?: ImageCrop; opacity?: number; }
export type Fill = SolidFill | GradientFill | ImageFill;

export interface TextStyleConfig {
  color?: Color; fontSize?: number; fontFamily?: FontFamily; bold?: boolean; italic?: boolean;
  backgroundColor?: Color; lineHeight?: number; lineHeightPx?: number; letterSpacing?: number; marginTop?: number;
}
export interface CellStyle extends TextStyleConfig { fill?: Fill; border?: BorderSpec; align?: Alignment; }
export interface TableStyleConfig {
  cellStyle?: CellStyle; firstRowStyle?: CellStyle; lastRowStyle?: CellStyle; firstColumnStyle?: CellStyle;
  lastColumnStyle?: CellStyle; bodyStyles?: CellStyle[]; rowOverColumn?: boolean;
}
export interface Theme {
  colors?: Record<string, Color>; textStyles?: Record<string, TextStyleConfig>; tableStyles?: Record<string, TableStyleConfig>;
  [key: string]: unknown;
}
export interface CustomFont { family: string; src: string; }

export interface ElementBase {
  elementId: string; elementType: "text" | "shape" | "line" | "image" | "icon" | "table" | "chart"; bounds: Bounds;
  [key: string]: unknown;
}
export interface TransformElementBase extends ElementBase { rotation?: number; opacity?: number; flip?: [boolean, boolean]; }
export interface TextContent extends TextStyleConfig {
  text: string; style?: string; textDirection?: "horizontal" | "vertical"; wrap?: boolean; align?: Alignment;
  gradient?: GradientFill; shadow?: Shadow; padding?: number | [number, number] | [number, number, number, number];
}
export interface PptdTextElement extends TransformElementBase { elementType: "text"; content: TextContent; }
export interface ShapeDef { shapeName: string; adjustments?: number[]; viewBox?: [number, number]; path?: string; }
export interface PptdShapeElement extends TransformElementBase, ShapeDef { elementType: "shape"; fill?: Fill | Color; border?: Border; shadow?: Shadow; }
export type ArrowType = "arrow" | "stealth" | "diamond" | "oval";
export interface PptdLineElement extends TransformElementBase {
  elementType: "line"; viewBox: [number, number]; points: string; curve?: "sharp" | "round" | "smooth";
  arrow?: [ArrowType | null, ArrowType | null]; border?: Border; shadow?: Shadow;
}
export interface PptdImageElement extends TransformElementBase {
  elementType: "image"; src: string; cropShape?: ShapeDef; fit?: ImageFit; crop?: ImageCrop; border?: Border; shadow?: Shadow;
}
export interface PptdIconElement extends TransformElementBase {
  elementType: "icon"; iconName: string; fill?: Fill | Color; border?: Border; shadow?: Shadow;
}
export interface Cell extends CellStyle {
  text?: string; textStyle?: string; rowSpan?: number; colSpan?: number;
}
export interface PptdTableElement extends ElementBase {
  elementType: "table"; columnWidths: number[]; rowHeights: number[]; rows: Cell[][];
  style?: string | TableStyleConfig; fill?: Fill; shadow?: Shadow;
}

export interface ChartData { cols: string[]; rows: Array<Array<number | string | boolean | null>>; }
export interface ChartTextStyle { color?: Color; fontSize?: number; fontFamily?: FontFamily; }
export interface TitleConfig extends ChartTextStyle { text: string; }
export interface LegendConfig extends ChartTextStyle { show?: boolean; position?: "top" | "bottom" | "left" | "right"; }
export interface DataLabelConfig extends ChartTextStyle { show?: boolean; content?: "value" | "percentage" | "category"; numberFormat?: string; }
export interface LineStyleConfig { style?: LineStyle; color?: Color; width?: number; }
export interface AxisConfig {
  show?: boolean; type?: "category" | "value"; min?: number; max?: number; reverse?: boolean; title?: string | TitleConfig;
  label?: boolean | (ChartTextStyle & { numberFormat?: string });
  axisLine?: boolean | (LineStyleConfig & { arrow?: boolean | "start" | "end" | "both" });
  gridLine?: boolean | LineStyleConfig;
}
export interface SpokeAxisConfig {
  show?: boolean; min?: number; max?: number; label?: boolean | (ChartTextStyle & { numberFormat?: string });
  axisLine?: boolean | LineStyleConfig; gridLine?: boolean | LineStyleConfig;
}
export interface MarkerConfig { shape?: "circle" | "rect" | "diamond" | "triangle"; fill?: Color | GradientFill; border?: Border; size?: number; }
export interface DataFilter { col: string; value: string | number; }
export type ChartType = "bar" | "line" | "area" | "scatter" | "bubble" | "candlestick" | "pie" | "radar" | "waterfall" | "heatmap" | "treemap" | "sunburst" | "sankey";
export interface SeriesBase { type: ChartType; name?: string; dataLabels?: false | DataLabelConfig; }
export interface LinearSeriesFields {
  smooth?: boolean; lineStyle?: LineStyle; width?: number; marker?: false | MarkerConfig;
  nullHandling?: "zero" | "gap" | "connect"; lineColor?: Color | GradientFill;
}
export interface BarSeries extends SeriesBase {
  type: "bar"; encode: { x: string; y: string }; xAxisIndex?: number; yAxisIndex?: number; stack?: "value" | "percent";
  symbol?: ShapeDef; fill?: Color | GradientFill; border?: Border;
}
export interface LineSeries extends SeriesBase, LinearSeriesFields { type: "line"; encode: { x: string; y: string }; xAxisIndex?: number; yAxisIndex?: number; }
export interface AreaSeries extends SeriesBase, LinearSeriesFields {
  type: "area"; encode: { x: string; y: string }; xAxisIndex?: number; yAxisIndex?: number;
  stack?: "value" | "percent" | "stream"; areaColor?: Color | GradientFill;
}
export interface ScatterSeries extends SeriesBase {
  type: "scatter"; encode: { x: string; y: string }; xAxisIndex?: number; yAxisIndex?: number; dataFilter?: DataFilter;
  marker?: MarkerConfig; fill?: Color | GradientFill; border?: Border;
}
export interface BubbleSeries extends SeriesBase {
  type: "bubble"; encode: { x: string; y: string; size: string }; xAxisIndex?: number; yAxisIndex?: number; dataFilter?: DataFilter;
  sizeScale?: "linear" | "sqrt" | "log"; sizeRange?: [number, number]; fill?: Color | GradientFill; border?: Border;
}
export interface CandlestickSeries extends SeriesBase {
  type: "candlestick"; encode: { x: string; high: string; low: string; close: string; open?: string }; xAxisIndex?: number; yAxisIndex?: number;
  upBars?: { fill?: Color; border?: Border }; downBars?: { fill?: Color; border?: Border }; wickStyle?: Border;
}
export interface PieSeries extends SeriesBase {
  type: "pie"; encode: { category: string; value: string }; innerRadius?: number; startAngle?: number;
  fill?: Color | GradientFill | Array<Color | GradientFill>; border?: Border;
}
export interface RadarSeries extends SeriesBase, LinearSeriesFields {
  type: "radar"; encode: { category: string; y: string }; areaColor?: Color | GradientFill;
}
export interface WaterfallSeries extends SeriesBase {
  type: "waterfall"; encode: { x: string; y: string; isTotal?: string };
  totalBars?: { fill?: Color; border?: Border }; increaseBars?: { fill?: Color; border?: Border }; decreaseBars?: { fill?: Color; border?: Border };
}
export interface HeatmapSeries extends SeriesBase {
  type: "heatmap"; encode: { x: string; y: string; value: string }; colorScheme?: Color[];
  colorScale?: { type?: "linear" | "diverging"; domain?: [number, number] }; colorbar?: boolean | LegendConfig;
}
export interface TreemapSeries extends SeriesBase {
  type: "treemap"; encode: { category: string; value: string; parent?: string }; levels?: number;
  fill?: Color | GradientFill | Array<Color | GradientFill> | Array<Array<Color | GradientFill>>; border?: Border;
}
export interface SunburstSeries extends SeriesBase {
  type: "sunburst"; encode: { category: string; value: string; parent?: string }; levels?: number;
  fill?: Color | GradientFill | Array<Color | GradientFill>; border?: Border;
}
export interface SankeySeries extends SeriesBase {
  type: "sankey"; encode: { source: string; target: string; flow: string }; nodeAlign?: "left" | "right" | "justify";
  fill?: Color | GradientFill | Array<Color | GradientFill> | Record<string, Color | GradientFill>; border?: Border;
}
export type ChartSeries = BarSeries | LineSeries | AreaSeries | ScatterSeries | BubbleSeries | CandlestickSeries | PieSeries | RadarSeries | WaterfallSeries | HeatmapSeries | TreemapSeries | SunburstSeries | SankeySeries;
export interface SeriesDefaults {
  bar?: Partial<Omit<BarSeries, "type" | "encode">>; line?: Partial<Omit<LineSeries, "type" | "encode">>;
  area?: Partial<Omit<AreaSeries, "type" | "encode">>; scatter?: Partial<Omit<ScatterSeries, "type" | "encode">>;
  bubble?: Partial<Omit<BubbleSeries, "type" | "encode">>; candlestick?: Partial<Omit<CandlestickSeries, "type" | "encode">>;
  radar?: Partial<Omit<RadarSeries, "type" | "encode">>;
}
export interface PptdChartElement extends ElementBase {
  elementType: "chart"; data: ChartData; series: ChartSeries[]; seriesDefaults?: SeriesDefaults;
  xAxis?: AxisConfig | AxisConfig[]; yAxis?: AxisConfig | AxisConfig[]; barWidth?: number; barGap?: number; categoryGap?: number;
  spokeAxis?: SpokeAxisConfig; title?: string | TitleConfig; legend?: boolean | LegendConfig; dataLabels?: DataLabelConfig;
  fontFamily?: FontFamily; fill?: Fill; border?: Border; shadow?: Shadow;
}

export type PptdElement = PptdTextElement | PptdShapeElement | PptdLineElement | PptdImageElement | PptdIconElement | PptdTableElement | PptdChartElement;
export type AnimationEffect = "appear" | "fade-in" | "fly-in" | "zoom-in" | "wipe-in" | "float-in" | "peek-in" | "rise-in" | "pulse" | "grow-shrink" | "spin" | "teeter" | "fill-color" | "transparency" | "color-pulse" | "disappear" | "fade-out" | "fly-out" | "zoom-out" | "wipe-out" | "float-out" | "motion-path";
export interface Animation {
  elementId: string; effect: AnimationEffect; trigger?: "onClick" | "withPrevious" | "afterPrevious";
  direction?: "up" | "down" | "left" | "right"; durationMs?: number; delayMs?: number;
  easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out"; repeat?: number; path?: string; color?: string; amount?: number;
}
export interface PptdPage {
  pageType?: "cover" | "table_of_contents" | "chapter" | "content" | "final" | string;
  background?: Fill; notes?: string; elements: PptdElement[]; animations?: Animation[]; [key: string]: unknown;
}
export interface PptdManifest {
  version: "v2" | string; title?: string; customFonts?: CustomFont[]; size: [number, number]; theme?: Theme; pages: string[];
  [key: string]: unknown;
}
export interface PptdProject {
  root: string; manifestPath: string; manifestSource: string; manifest: PptdManifest;
  pages: Array<{ path: string; absolutePath: string; source: string; data: PptdPage; index: number }>;
  size: [number, number]; title: string;
}
export interface ValidationIssue { level: "error" | "warning"; code: string; message: string; page?: string; element?: string | null; }
export interface YamlCstDocument<T = unknown> { source: string; value: T; lines: string[]; comments: string[]; order: string[]; }

export declare function parseYaml(source: string): unknown;
export declare function stringifyYaml(value: unknown, indent?: number): string;
export declare function parseYamlCst<T = unknown>(source: string): YamlCstDocument<T>;
export declare function setYamlCst<T>(document: YamlCstDocument<T>, path: string | Array<string | number>, value: unknown): YamlCstDocument<T>;
export declare function updateYamlCst<T>(document: YamlCstDocument<T>, nextValue: T): YamlCstDocument<T>;
export declare function stringifyYamlCst(document: YamlCstDocument | unknown): string;
export declare function latexToOmml(latex: string): string;
export declare const PRESET_SHAPE_NAMES: string[];
export declare const SHAPE_ADJUSTMENTS: Record<string, number[]>;
export declare const SHAPE_ADJUSTMENT_NAMES: Record<string, string[]>;
export interface EcmaPresetGeometry {
  a: Array<[string, number]>;
  g: Array<[string, number, string | number | null, string | number | null, string | number | null]>;
  p: Array<Array<string | number | boolean | null>>;
}
export declare const ECMA_PRESET_GEOMETRIES: Record<string, EcmaPresetGeometry>;
export declare function resolveColor(value: Color, theme?: Theme): string;
export declare function findManifest(input: string): string;
export declare function loadProject(input: string): PptdProject;
export declare function validateProject(input: string): { valid: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[]; project: PptdProject | null };
export declare function renderPageSvg(page: PptdPage, options?: { size?: [number, number]; theme?: Theme; resourceResolver?: (path: string) => string; includeMetadata?: boolean; includeElementMetadata?: boolean }): string;
export declare function resolveProjectResource(root: string, resourcePath: string): string;
export declare function exportPptx(projectOrInput: PptdProject | string, outputPath: string, options?: { transition?: "fade" | "none"; embedFonts?: "auto" | "force" | "none"; force?: boolean }): { output: string; pages: number; media: number; charts: number; fonts: number; notes: number; transition: "fade" | "none" };
export declare function makeZip(entries: Record<string, string | Buffer>): Buffer;
export declare function sha256(value: string | Buffer): string;
export declare function fontEmbeddingPolicy(bytes: Buffer | Uint8Array, options?: { force?: boolean }): { allowed: boolean; forced?: boolean; fsType?: number; reason: string };
export declare function verifyOoxmlEntries(files: Record<string, string | Buffer>, expectedSlides: number): { slides: number; parts: number };
