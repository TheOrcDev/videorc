// ChromaKeySpec, scene_geometry.rs and Metal key_alpha, in normalized RGB.
// The nine bilinear taps implement the native 5x5 binomial colour judge.
export const KEY_VERTEX = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = vec2(p.x, 1.0-p.y);
  gl_Position = vec4(p*2.0-1.0,0,1);
}`
export const KEY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outputColor;
uniform sampler2D camera;
uniform sampler2D background;
uniform vec2 direction;
uniform vec2 cone;
uniform vec4 edges;
uniform float spill;
uniform bool blue;
float alphaFor(vec3 rgb) {
  vec3 c = rgb * 255.0;
  vec2 chroma = vec2(dot(c,vec3(-43,-85,128)),dot(c,vec3(128,-107,-21)))/256.0;
  float sat = length(chroma);
  float floorValue = clamp(0.15*dot(c,vec3(77,150,29))/256.0,5.0,14.0);
  if (sat <= floorValue || length(direction) < 0.5) return 1.0;
  float angle = degrees(acos(clamp(dot(chroma,direction)/sat,-1.0,1.0)));
  float a = cone.y > 0.0 ? clamp((angle-cone.x)/cone.y,0.0,1.0) : (angle <= cone.x ? 0.0 : 1.0);
  return 1.0-clamp((sat-floorValue)/(floorValue*6.0/14.0),0.0,1.0)*(1.0-a);
}
void main() {
  vec3 bg = texture(background,uv).rgb;
  if (uv.x < edges.x || uv.y < edges.y || uv.x > edges.z || uv.y > edges.w) {
    outputColor = vec4(bg,1); return;
  }
  vec3 color = texture(camera,uv).rgb;
  vec3 judged = vec3(0);
  vec2 stepSize = 1.2/vec2(textureSize(camera,0));
  for (int j=-1;j<=1;j++) for(int i=-1;i<=1;i++) {
    float weight = (i==0 ? 6.0 : 5.0)*(j==0 ? 6.0 : 5.0)/256.0;
    judged += texture(camera,uv+vec2(float(i),float(j))*stepSize).rgb*weight;
  }
  float alpha = alphaFor(judged);
  if (blue) color.b -= spill*max(0.0,color.b-max(color.r,color.g));
  else color.g -= spill*max(0.0,color.g-max(color.r,color.b));
  outputColor = vec4(mix(bg,color,alpha),1);
}`
