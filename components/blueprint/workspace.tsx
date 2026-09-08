'use client';
import { useState } from 'react';
import { MotionConfig } from 'framer-motion';
import { Download, Layers3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Explorer from './explorer';

export default function BlueprintWorkspace() {
  const [quiet, setQuiet] = useState(false);
  return (
    <MotionConfig reducedMotion={quiet ? 'always' : 'user'}>
      <div className="blueprint-app">
        <header className="topbar">
          <a className="brand" href="#main">
            <Layers3 size={25} />
            <span>
              ultratokenizer<span className="brand-dot">.</span>
            </span>
          </a>
          <span className="product-label">ZK Self-Sovereign Tokenizer</span>
          <Button
            variant="ghost"
            className="motion-toggle"
            aria-pressed={quiet}
            onClick={() => setQuiet(!quiet)}
          >
            {quiet ? 'Enable motion' : 'Reduce motion'}
          </Button>
        </header>
        <main id="main">
          <Explorer quiet={quiet} />
        </main>
        <footer>
          <span>Ultratokenizer / Architecture blueprint</span>
          <a href="./ultratokenizer-blueprint.html" download>
            <Download size={16} /> Download interactive HTML
          </a>
          <span>Design scenarios, not live transactions.</span>
        </footer>
      </div>
    </MotionConfig>
  );
}
