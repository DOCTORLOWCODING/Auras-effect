export const SHADERS = Object.freeze({
  spirits: `
    uniform vec2 size;
    uniform float time;
    uniform vec3 auraColor;
    uniform float alpha;
    uniform float speed;

    float wisp(vec2 p, float angle) {
      vec2 c = vec2(cos(angle), sin(angle)) * 0.88;
      vec2 q = p - c;
      q.x *= 0.78;
      float d = length(q);
      float core = 1.0 - smoothstep(0.018, 0.070, d);
      float halo = 1.0 - smoothstep(0.035, 0.145, d);
      return max(core, halo * 0.42);
    }

    half4 main(float2 coord) {
      vec2 p = (coord / size - vec2(0.5)) * 2.0;
      float t = time * max(speed, 0.15);
      float particles = max(max(wisp(p, t), wisp(p, t + 1.5707963)),
                            max(wisp(p, t + 3.1415926), wisp(p, t + 4.7123890)));
      float d = length(p);
      float a = atan(p.y, p.x);
      float orbit = 0.975 + 0.012 * sin(a * 4.0 - t * 1.3);
      float trailMask = 1.0 - smoothstep(0.008, 0.022, abs(d - orbit));
      float trailPulse = pow(max(0.0, cos(a * 4.0 - t * 1.3)), 8.0);
      float trail = trailMask * trailPulse * 0.46;
      float alphaOut = clamp(max(particles, trail) * alpha, 0.0, 1.0);
      vec3 rgb = mix(auraColor, vec3(0.92, 0.98, 1.0), clamp(particles, 0.0, 1.0));
      return half4(rgb * alphaOut, alphaOut);
    }
  `,
  electric: `
    uniform vec2 size;
    uniform float time;
    uniform vec3 auraColor;
    uniform float alpha;
    uniform float speed;

    half4 main(float2 coord) {
      vec2 p = (coord / size - vec2(0.5)) * 2.0;
      float d = length(p);
      float a = atan(p.y, p.x);
      float t = time * max(speed, 0.15);
      float wave1 = abs(sin(a * 11.0 + sin(a * 3.0 + t * 1.7) * 2.0 + t * 2.4));
      float wave2 = abs(sin(a * 23.0 - t * 3.1 + sin(a * 7.0 + t) * 1.1));
      float bolt1 = (1.0 - smoothstep(0.025, 0.095, wave1)) *
        smoothstep(0.12, 0.28, d) * (1.0 - smoothstep(0.84, 0.98, d));
      float bolt2 = (1.0 - smoothstep(0.018, 0.075, wave2)) *
        smoothstep(0.28, 0.52, d) * (1.0 - smoothstep(0.88, 0.99, d)) * 0.72;
      float corona = (1.0 - smoothstep(0.006, 0.020, abs(d - (0.975 + 0.012 * sin(t * 2.0 + a * 3.0))))) * 0.32;
      float sparks = pow(max(0.0, cos(a * 17.0 + t * 2.2)), 24.0) *
        (1.0 - smoothstep(0.012, 0.035, abs(d - 0.985)));
      float energy = max(max(bolt1, bolt2), max(corona, sparks));
      float alphaOut = clamp(energy * alpha, 0.0, 1.0);
      vec3 rgb = mix(auraColor, vec3(0.82, 0.97, 1.0), clamp(energy, 0.0, 1.0));
      return half4(rgb * alphaOut, alphaOut);
    }
  `,
  // True screen-space magnification. POST_PROCESS provides the scene shader.
  // Screen-space refractive lens. The local Effect coordinates are transformed
  // into the same screen coordinate space used by the POST_PROCESS scene shader.
  // This avoids zoom-dependent sampling drift and preserves the original scene
  // wherever the lens is not actively refracting it.
  lens: `
    uniform vec2 size;
    uniform float time;
    uniform float dpi;
    uniform float numUnits;
    uniform float itemRadiusUnits;
    uniform float warpFactor;
    uniform float speed;
    uniform mat3 model;
    uniform mat3 view;
    uniform shader scene;

    const float TIME_FACTOR = 0.2;
    const float TIME_WARP_FACTOR = 0.1;
    const float PI = 3.14159;

    float scaleOffset(float pct) {
      // Original Auras and Emanations Distort pulse: zero at 0, 0.5 and 1,
      // with alternating inward/outward displacement between those points.
      return sin(PI * pct) * sin(2.0 * PI * pct) * dpi *
        (warpFactor + sin(time * TIME_FACTOR * max(speed, 0.15)) * TIME_WARP_FACTOR);
    }

    half4 main(float2 fragCoordPx) {
      float radiusPx = (numUnits + itemRadiusUnits) * dpi;
      vec2 centerRelativeCoordPx = fragCoordPx - size * 0.5;
      float distancePx = length(centerRelativeCoordPx);
      float pct = clamp(distancePx / max(radiusPx, 0.001), 0.0, 1.0);
      vec2 direction = distancePx > 0.001
        ? centerRelativeCoordPx / distancePx
        : vec2(0.0, 0.0);

      // Distort uses the model matrix to move from effect-local coordinates
      // into world space, then view to obtain scene sampling coordinates.
      // Keep this exact order: POST_PROCESS scene.eval expects view coordinates.
      vec2 worldCoordPx = (vec3(fragCoordPx, 1.0) * model).xy;
      worldCoordPx += direction * scaleOffset(pct);
      vec2 viewCoordPx = (vec3(worldCoordPx, 1.0) * view).xy;
      return scene.eval(viewCoordPx);
    }
  `,
  glow: `
    uniform vec2 size;
    uniform float time;
    uniform vec3 auraColor;
    uniform float alpha;
    uniform float speed;

    half4 main(float2 coord) {
      vec2 p = (coord / size - vec2(0.5)) * 2.0;
      float d = length(p);
      float a = atan(p.y, p.x);
      float t = time * max(speed, 0.15);
      float radius = 0.84 + 0.025 * sin(t * 1.15);
      float rim = 1.0 - smoothstep(0.012, 0.045, abs(d - radius));
      float innerWave = 1.0 - smoothstep(0.008, 0.032, abs(d - (0.57 + 0.025 * sin(t + a * 2.0))));
      float outerWave = 1.0 - smoothstep(0.006, 0.020, abs(d - 0.985));
      float arc = pow(max(0.0, cos(a * 5.0 - t * 1.4)), 14.0) * rim;
      float pulse = 0.52 + 0.48 * sin(t * 1.7) * sin(t * 1.7);
      float energy = max(max(rim * pulse, innerWave * 0.36), max(outerWave * 0.25, arc));
      float alphaOut = clamp(energy * alpha, 0.0, 1.0);
      vec3 rgb = mix(auraColor, vec3(1.0), clamp(arc + rim * 0.22, 0.0, 0.65));
      return half4(rgb * alphaOut, alphaOut);
    }
  `,
  shield: `
    uniform vec2 size;
    uniform float time;
    uniform vec3 auraColor;
    uniform float alpha;
    uniform float speed;

    half4 main(float2 coord) {
      vec2 p = (coord / size - vec2(0.5)) * 2.0;
      float d = length(p);
      float t = time * max(speed, 0.15);
      float inside = 1.0 - smoothstep(0.91, 1.02, d);
      float rim = 1.0 - smoothstep(0.012, 0.055, abs(d - (0.91 + 0.012 * sin(t * 0.8))));
      float innerRim = 1.0 - smoothstep(0.012, 0.045, abs(d - 0.84));
      float shinePosition = 0.42 + 0.08 * sin(t * 0.55);
      float shine = exp(-pow((p.x + 0.34) * 4.2, 2.0) - pow((p.y + shinePosition) * 6.0, 2.0));
      float body = inside * (0.10 + 0.06 * (1.0 - d));
      float energy = body + rim * 0.52 + innerRim * 0.12 + shine * 0.68;
      float alphaOut = clamp(energy * alpha, 0.0, 1.0);
      vec3 rgb = mix(auraColor, vec3(0.92, 0.98, 1.0), clamp(rim * 0.65 + shine, 0.0, 0.92));
      return half4(rgb * alphaOut, alphaOut);
    }
  `,
  touch: `
    uniform vec2 size;
    uniform float time;
    uniform vec3 auraColor;
    uniform float alpha;
    uniform float speed;

    half4 main(float2 coord) {
      vec2 p = (coord / size - vec2(0.5)) * 2.0;
      float d = length(p);
      float t = time * max(speed, 0.15);
      float r1 = 0.22 + fract(t * 0.12) * 0.70;
      float r2 = 0.22 + fract(t * 0.12 + 0.34) * 0.70;
      float r3 = 0.22 + fract(t * 0.12 + 0.68) * 0.70;
      float wave1 = (1.0 - smoothstep(0.008, 0.032, abs(d - r1))) * (1.0 - fract(t * 0.12));
      float wave2 = (1.0 - smoothstep(0.008, 0.032, abs(d - r2))) * (1.0 - fract(t * 0.12 + 0.34));
      float wave3 = (1.0 - smoothstep(0.008, 0.032, abs(d - r3))) * (1.0 - fract(t * 0.12 + 0.68));
      float energy = max(max(wave1, wave2), wave3) * 0.72;
      float alphaOut = clamp(energy * alpha, 0.0, 1.0);
      vec3 rgb = mix(auraColor, vec3(0.92, 0.98, 1.0), energy * 0.35);
      return half4(rgb * alphaOut, alphaOut);
    }
  `,
  fog: `
    uniform vec2 size;
    uniform float time;
    uniform vec3 auraColor;
    uniform float alpha;
    uniform float speed;
    uniform float light;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    float noise2(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash21(i);
      float b = hash21(i + vec2(1.0, 0.0));
      float c = hash21(i + vec2(0.0, 1.0));
      float d = hash21(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    half4 main(float2 coord) {
      vec2 p = (coord / size - vec2(0.5)) * 2.0;
      float d = length(p);
      float t = time * max(speed, 0.15) * 0.12;
      float n1 = noise2(p * 4.0 + vec2(t, -t * 0.7));
      float n2 = noise2(p * 8.0 + vec2(-t * 0.55, t));
      float cloud = n1 * 0.68 + n2 * 0.32;
      float edge = 1.0 - smoothstep(0.72 + (cloud - 0.5) * 0.22, 1.04, d);
      float body = smoothstep(0.15, 0.72, cloud) * edge;
      float lightValue = clamp(light, 0.0, 1.0);
      float glow = (0.22 + lightValue * 0.78) * body;
      float alphaOut = clamp((body * 0.42 + glow * 0.34) * alpha, 0.0, 1.0);
      vec3 rgb = mix(auraColor, vec3(1.0), lightValue * 0.62);
      return half4(rgb * alphaOut, alphaOut);
    }
  `,
});
