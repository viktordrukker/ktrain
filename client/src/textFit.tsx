import React, { useLayoutEffect, useRef, useState } from "react";

export type FitMetrics = {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  container: { width: number; height: number };
  text: { width: number; height: number };
  spare: { width: number; height: number };
};

export type FitConfig = {
  scale: number;
  min: number;
  max: number;
  lineHeight: number;
  letterSpacing: number;
  allowWrap: boolean;
};

export function computeFit(
  measure: (fontSize: number) => { width: number; height: number },
  container: { width: number; height: number },
  config: FitConfig
) {
  const min = Math.max(8, config.min * config.scale);
  const max = Math.max(min, config.max * config.scale);
  if (container.width <= 0 || container.height <= 0) {
    return { fontSize: min, width: 0, height: 0 };
  }

  let low = min;
  let high = max;
  for (let i = 0; i < 14; i += 1) {
    const mid = (low + high) / 2;
    const size = measure(mid);
    const fits = size.width <= container.width * 0.98 && size.height <= container.height * 0.98;
    if (fits) {
      low = mid;
    } else {
      high = mid;
    }
  }
  const finalSize = Math.max(min, Math.min(low, max));
  const finalMeasured = measure(finalSize);
  return { fontSize: finalSize, width: finalMeasured.width, height: finalMeasured.height };
}

export function useTextFitEngine(text: string, config: FitConfig) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState<FitMetrics>(() => ({
    fontSize: config.min * config.scale,
    lineHeight: config.lineHeight,
    letterSpacing: config.letterSpacing,
    container: { width: 0, height: 0 },
    text: { width: 0, height: 0 },
    spare: { width: 0, height: 0 }
  }));

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    let frame = 0;

    const update = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const result = computeFit(
        (fontSize) => {
          measure.style.fontSize = `${fontSize}px`;
          measure.style.lineHeight = String(config.lineHeight);
          measure.style.letterSpacing = `${config.letterSpacing}em`;
          measure.style.whiteSpace = config.allowWrap ? "pre-wrap" : "nowrap";
          measure.style.width = config.allowWrap ? `${rect.width}px` : "auto";
          measure.textContent = text || " ";
          const measuredRect = measure.getBoundingClientRect();
          return { width: measuredRect.width, height: measuredRect.height };
        },
        { width: rect.width, height: rect.height },
        config
      );

      const next: FitMetrics = {
        fontSize: result.fontSize,
        lineHeight: config.lineHeight,
        letterSpacing: config.letterSpacing,
        container: { width: rect.width, height: rect.height },
        text: { width: result.width, height: result.height },
        spare: {
          width: Math.max(0, rect.width - result.width),
          height: Math.max(0, rect.height - result.height)
        }
      };

      setMetrics((prev) => {
        const sizeStable = Math.abs(prev.fontSize - next.fontSize) < 0.5;
        const containerStable = Math.abs(prev.container.width - next.container.width) < 1
          && Math.abs(prev.container.height - next.container.height) < 1;
        if (sizeStable && containerStable) return prev;
        return next;
      });
    };

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    });

    observer.observe(container);
    update();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [text, config.scale, config.min, config.max, config.lineHeight, config.letterSpacing, config.allowWrap]);

  return { containerRef, measureRef, metrics };
}

export type TaskTextProps = {
  text: string;
  className?: string;
  textClassName?: string;
  config: FitConfig;
  showBounds?: boolean;
  dataId?: string;
  children?: React.ReactNode;
  onMetrics?: (metrics: FitMetrics) => void;
};

export function TaskText({ text, className, textClassName, config, showBounds, dataId, children, onMetrics }: TaskTextProps) {
  const { containerRef, measureRef, metrics } = useTextFitEngine(text, config);

  React.useEffect(() => {
    if (onMetrics) onMetrics(metrics);
  }, [metrics, onMetrics]);

  return (
    <div
      ref={containerRef}
      className={className ? `task-fit ${className}` : "task-fit"}
      data-id={dataId}
      data-font-size={Math.round(metrics.fontSize)}
      data-container={`${Math.round(metrics.container.width)}x${Math.round(metrics.container.height)}`}
      data-text={`${Math.round(metrics.text.width)}x${Math.round(metrics.text.height)}`}
    >
      <div
        className={textClassName ? `task-text ${textClassName}` : "task-text"}
        data-wrap={config.allowWrap ? "true" : "false"}
        style={{
          fontSize: metrics.fontSize,
          lineHeight: metrics.lineHeight,
          letterSpacing: `${metrics.letterSpacing}em`,
          whiteSpace: config.allowWrap ? "pre-wrap" : "nowrap"
        }}
      >
        {children ?? text}
      </div>
      <div
        ref={measureRef}
        className="task-text measure"
        style={{
          fontSize: metrics.fontSize,
          lineHeight: metrics.lineHeight,
          letterSpacing: `${metrics.letterSpacing}em`,
          whiteSpace: config.allowWrap ? "pre-wrap" : "nowrap"
        }}
        aria-hidden="true"
      />
      {showBounds && (
        <div className="fit-bounds">
          <div
            className="fit-bounds-inner"
            style={{
              width: Math.round(metrics.text.width),
              height: Math.round(metrics.text.height),
              left: `calc(50% - ${Math.round(metrics.text.width) / 2}px)`,
              top: `calc(50% - ${Math.round(metrics.text.height) / 2}px)`
            }}
          />
        </div>
      )}
    </div>
  );
}
