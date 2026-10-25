"use client";

import { Canvas } from "@react-three/fiber";
import { useGLTF, Float, Environment } from "@react-three/drei";
import { Suspense } from "react";
import * as THREE from "three";

// MEKANIX — 3D Logo component for splash
//
// Renders the logo3d.glb model with a gentle floating animation and
// ambient lighting. Falls back gracefully if the model fails to load
// (the parent shows a 2D logo behind the Canvas).
//
// Performance:
//   - dpr={[1, 2]} caps pixel ratio for high-DPI screens
//   - gl={{ antialias: true, alpha: true }} for smooth edges + transparency
//   - No shadows (cheaper) — the model is lit by ambient + directional only

function LogoModel() {
  const { scene } = useGLTF("/logo3d.glb");

  // Clone the scene so we don't mutate the cached original across mounts.
  const cloned = scene.clone(true);

  // Normalize: center the geometry and scale to fit a ~3 unit bounding box.
  const box = new THREE.Box3().setFromObject(cloned);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 3 / maxDim;

  cloned.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // Keep original materials; just ensure they're visible.
      if (mesh.material) {
        const mat = mesh.material as THREE.Material;
        mat.transparent = false;
        mat.needsUpdate = true;
      }
    }
  });

  return (
    <group
      position={[-center.x * scale, -center.y * scale, -center.z * scale]}
      scale={scale}
    >
      <primitive object={cloned} />
    </group>
  );
}

function LoadingFallback() {
  return null;
}

export function Logo3D({
  width = 240,
  height = 220,
}: {
  width?: number;
  height?: number;
}) {
  return (
    <div style={{ width, height }} className="relative">
      <Canvas
        camera={{ position: [0, 0, 6], fov: 45 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        style={{ width: "100%", height: "100%" }}
      >
        {/* Lighting — warm amber key light + cool fill */}
        <ambientLight intensity={0.4} />
        <directionalLight position={[3, 4, 5]} intensity={1.2} color={"#ffffff"} />
        <directionalLight position={[-3, -2, -4]} intensity={0.4} color={"#F38E00"} />
        <pointLight position={[0, 0, 3]} intensity={0.5} color={"#F38E00"} />

        <Suspense fallback={<LoadingFallback />}>
          <Float
            speed={1.4}
            rotationIntensity={0.35}
            floatIntensity={0.6}
            floatingRange={[-0.15, 0.15]}
          >
            <LogoModel />
          </Float>
          <Environment preset="city" />
        </Suspense>
      </Canvas>
    </div>
  );
}

// Preload the model for faster splash render.
useGLTF.preload("/logo3d.glb");
