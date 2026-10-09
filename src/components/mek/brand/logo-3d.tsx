"use client";

import { Suspense, useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { useGLTF, Center } from "@react-three/drei";
import * as THREE from "three";

/**
 * Logo3D — renders the MEKANIX GLB logo on a transparent canvas.
 *
 * The GLB contains a horizontal "MEKANIX" lockup where the M emblem (with the
 * orange diamond) replaces the M in the wordmark. The geometry is:
 *   4.07 wide × 0.35 tall × 3.20 deep  (W:H:D ≈ 11.7:0.1:0.8)
 * Viewed straight-on it's a thin horizontal strip. We tilt the logo ~32° back
 * so its deep extrusion becomes visible — turning it from a flat bar into a
 * proper 3D mark that fills the square canvas.
 *
 * The GLB also ships a 200×200-unit "Dark_Graphite_Background" plane we must
 * skip (it fills the camera and washes the frame white).
 */

const TILT_X = -0.62;   // ~−35°: shows the deep extrusion while keeping the wordmark readable
const DRIFT_AMP_Y = 0.18; // gentle Y drift so it reads as 3D without going edge-on
const Y_OFFSET = -0.25;  // compensate for tilt-induced upward shift so the logo sits centered

// A node is part of the actual logo if its name mentions Emblem/Diamond/Wordmark.
// (The GLB also ships a giant "Dark_Graphite_Background" plane we must skip.)
function isLogoNode(name: string): boolean {
  const n = name.toLowerCase();
  if (n.includes("background") || n.includes("graphite") || n.includes("dark_")) return false;
  return (
    n.includes("emblem") ||
    n.includes("diamond") ||
    n.includes("wordmark") ||
    n.includes("m_") ||
    n.includes("ix") ||
    n.includes("mekan")
  );
}

function Logo3DModel({ url }: { url: string }) {
  const outer = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Group>(null);
  const gltf = useGLTF(url);

  const collected = useMemo(() => {
    const source = gltf?.scene;
    if (!source) return null;
    const meshes: THREE.Mesh[] = [];
    source.traverse((o: THREE.Object3D) => {
      if (!isLogoNode(o.name)) return;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const clone = mesh.clone();
      // Clone material so we can set side without mutating the cached GLTF.
      const srcMat = clone.material as THREE.Material | THREE.Material[];
      if (Array.isArray(srcMat)) {
        clone.material = srcMat.map((m) => {
          const c = (m as THREE.Material).clone();
          c.side = THREE.DoubleSide;
          return c;
        });
      } else if (srcMat) {
        const c = srcMat.clone();
        c.side = THREE.DoubleSide;
        clone.material = c;
      }
      meshes.push(clone);
    });
    return meshes.length ? meshes : null;
  }, [gltf]);

  useFrame((_, delta) => {
    // Apply the tilt to the outer group (constant), drift to the inner group.
    if (outer.current) outer.current.rotation.x = TILT_X;
    if (inner.current) {
      const t = (inner.current as any).userData.t || 0;
      const next = t + delta;
      (inner.current as any).userData.t = next;
      inner.current.rotation.y = Math.sin(next * 0.5) * DRIFT_AMP_Y;
      // Slight vertical bob so the lighting highlights shift.
      inner.current.rotation.z = Math.sin(next * 0.3) * 0.03;
    }
  });

  if (!collected) return null;

  // Outer group: holds the constant tilt. Inner group: holds the drift animation.
  // <Center> sits between them so it re-centers the geometry before the tilt is applied.
  return (
    <group ref={outer} position={[0, Y_OFFSET, 0]}>
      <Center>
        <group ref={inner} dispose={null} scale={0.95}>
          {collected.map((m, i) => (
            <primitive key={i} object={m} />
          ))}
        </group>
      </Center>
    </group>
  );
}

function LoadingFallback() {
  return (
    <mesh>
      <boxGeometry args={[0.6, 0.6, 0.6]} />
      <meshStandardMaterial color="#F5A524" wireframe />
    </mesh>
  );
}

export function Logo3D({
  url = "/logo3d.glb",
  width = 220,
  height = 220,
}: {
  url?: string;
  width?: number;
  height?: number;
}) {
  return (
    <div style={{ width, height }}>
      <Canvas
        camera={{ position: [0, 0.4, 7], fov: 32, near: 0.1, far: 100 }}
        style={{ width: "100%", height: "100%", background: "transparent" }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: false }}
        onCreated={({ gl, scene }) => {
          gl.setClearColor(0x000000, 0); // transparent clear — page bg shows through
          scene.background = null; // no scene background
        }}
      >
        {/* Lighting rig — explicit, no CDN env map. */}
        <ambientLight intensity={0.55} />
        <hemisphereLight args={["#ffffff", "#1a1a1a", 0.5]} />
        {/* Key light — warm white from top-right-front */}
        <directionalLight position={[5, 7, 6]} intensity={2.8} color="#ffffff" />
        {/* Rim — amber from back-left to catch the extrusion edges */}
        <directionalLight position={[-6, 3, -4]} intensity={1.6} color="#F5A524" />
        {/* Fill — cool from below to soften shadows */}
        <directionalLight position={[0, -5, 3]} intensity={0.5} color="#cfe2ff" />
        <Suspense fallback={<LoadingFallback />}>
          <Logo3DModel url={url} />
        </Suspense>
      </Canvas>
    </div>
  );
}

useGLTF.preload("/logo3d.glb");
