/// <reference types="vite/client" />

import { useEffect, useRef, useState } from 'react';
import shaderSource from './liquid-voice-orb.wgsl?raw';
import { LIQUID_VOICE_ORB_UNIFORMS } from './liquid-voice-orb-preset';

export type LiquidVoiceOrbPhase = 'waking' | 'hearing' | 'analyzing';

type GpuContext = {
  configure(options: { device: unknown; format: string; alphaMode: 'premultiplied' }): void;
  getCurrentTexture(): { createView(): unknown };
  unconfigure?(): void;
};

type GpuBuffer = { destroy?(): void };

type GpuDevice = {
  queue: {
    writeBuffer(buffer: unknown, offset: number, data: Float32Array): void;
    submit(commands: unknown[]): void;
  };
  lost?: Promise<{ message?: string; reason?: string }>;
  createShaderModule(descriptor: { code: string }): {
    getCompilationInfo?(): Promise<{ messages: Array<{ type: string; lineNum?: number; linePos?: number; message: string }> }>;
  };
  createRenderPipeline(descriptor: unknown): {
    getBindGroupLayout(index: number): unknown;
  };
  createBuffer(descriptor: { size: number; usage: number }): GpuBuffer;
  createBindGroup(descriptor: { layout: unknown; entries: Array<{ binding: number; resource: { buffer: unknown } }> }): unknown;
  createCommandEncoder(): {
    beginRenderPass(descriptor: unknown): {
      setPipeline(pipeline: unknown): void;
      setBindGroup(index: number, bindGroup: unknown): void;
      draw(vertexCount: number): void;
      end(): void;
    };
    finish(): unknown;
  };
  destroy?(): void;
  addEventListener?(type: 'uncapturederror', listener: (event: { error: { message: string } }) => void): void;
};

type GpuAdapter = { requestDevice(): Promise<GpuDevice> };
type GpuApi = {
  requestAdapter(): Promise<GpuAdapter | null>;
  getPreferredCanvasFormat(): string;
};

const UNIFORM_USAGE_UNIFORM = 0x0040;
const UNIFORM_USAGE_COPY_DST = 0x0008;
const SIZE_X = 0;
const SIZE_Y = 1;
const TIME = 2;
const SPEED = 3;
const EXPOSURE = 14;

const phaseSpeed: Record<LiquidVoiceOrbPhase, number> = {
  waking: 0.82,
  hearing: 1.08,
  analyzing: 1.42,
};

function getGpu(): GpuApi | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { gpu?: GpuApi }).gpu;
}

function isReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function LiquidVoiceOrb({ phase }: { phase: LiquidVoiceOrbPhase }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(phase);
  const fallbackRef = useRef(false);
  const [fallback, setFallback] = useState(false);
  phaseRef.current = phase;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window === 'undefined') return undefined;

    let frame: number | null = null;
    let stopped = false;
    let disposed = false;
    let device: GpuDevice | undefined;
    let context: GpuContext | undefined;
    let uniformBuffer: GpuBuffer | undefined;

    const transitionToFallback = () => {
      if (stopped || fallbackRef.current) return;
      fallbackRef.current = true;
      setFallback(true);
    };

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      stopped = true;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      try { uniformBuffer?.destroy?.(); } catch { /* cleanup continues */ }
      try { context?.unconfigure?.(); } catch { /* cleanup continues */ }
      try { device?.destroy?.(); } catch { /* cleanup continues */ }
    };

    const run = async () => {
      const gpu = getGpu();
      const adapter = await gpu?.requestAdapter();
      if (stopped) return;
      if (!adapter || !gpu) throw new Error('WEBGPU_UNAVAILABLE');

      const acquiredDevice = await adapter.requestDevice();
      if (stopped) {
        try { acquiredDevice.destroy?.(); } catch { /* cleanup continues */ }
        return;
      }
      device = acquiredDevice;

      context = canvas.getContext('webgpu' as never) as unknown as GpuContext | null ?? undefined;
      if (!context) throw new Error('WEBGPU_CONTEXT_UNAVAILABLE');
      const format = gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: 'premultiplied' });

      const shader = device.createShaderModule({ code: shaderSource });
      const compilation = await shader.getCompilationInfo?.();
      if (stopped) return;
      const errors = compilation?.messages.filter((message) => message.type === 'error') ?? [];
      if (errors.length) {
        throw new Error(errors.map((message) => String(message.lineNum ?? 0) + ':' + String(message.linePos ?? 0) + ' ' + message.message).join('\n'));
      }

      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: shader, entryPoint: 'vs_main' },
        fragment: { module: shader, entryPoint: 'fs_main', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      const values = new Float32Array(LIQUID_VOICE_ORB_UNIFORMS);
      uniformBuffer = device.createBuffer({
        size: values.byteLength,
        usage: UNIFORM_USAGE_UNIFORM | UNIFORM_USAGE_COPY_DST,
      });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
      });
      const startedAt = performance.now();

      const draw = (now: number) => {
        if (stopped || !device) return;
        try {
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
          const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }

          values[SIZE_X] = width;
          values[SIZE_Y] = height;
          values[TIME] = (now - startedAt) / 1000;
          values[SPEED] = phaseSpeed[phaseRef.current];
          values[EXPOSURE] = phaseRef.current === 'analyzing' ? 1.08 : 1;
          device.queue.writeBuffer(uniformBuffer, 0, values);

          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [{
              view: context!.getCurrentTexture().createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store',
            }],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.draw(3);
          pass.end();
          device.queue.submit([encoder.finish()]);
          if (!isReducedMotion()) frame = window.requestAnimationFrame(draw);
        } catch (error) {
          if (stopped) return;
          transitionToFallback();
          dispose();
          console.error(error);
        }
      };

      void device.lost?.then((info) => {
        if (stopped) return;
        if (info.message) console.error(new Error('WebGPU device lost: ' + info.message));
        transitionToFallback();
        dispose();
      });
      device.addEventListener?.('uncapturederror', (event) => {
        if (stopped) return;
        transitionToFallback();
        dispose();
        console.error(new Error('WebGPU rendering error: ' + event.error.message));
      });

      if (stopped) return;
      if (isReducedMotion()) draw(performance.now());
      else frame = window.requestAnimationFrame(draw);
    };

    void run().catch((error) => {
      if (stopped) return;
      if (!(error instanceof Error && error.message === 'WEBGPU_UNAVAILABLE')) console.error(error);
      transitionToFallback();
      dispose();
    });

    return dispose;
  }, []);

  return (
    <div
      className={'liquid-voice-orb' + (fallback ? ' liquid-voice-orb--fallback' : '')}
      data-phase={phase}
      data-testid="liquid-voice-orb"
    >
      <canvas aria-label="动态液态呼吸球" ref={canvasRef} />
      {fallback && <span aria-hidden="true" className="liquid-voice-orb__fallback" />}
    </div>
  );
}