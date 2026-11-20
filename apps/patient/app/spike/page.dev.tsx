import SpikeRunner from "../spike-runner";

export const metadata = { title: "ChartStays runtime spike" };

export default function SpikePage() {
  return (
    <main id="content" tabIndex={-1}>
      <h1>Runtime spike</h1>
      <p>
        Boots the vendored agentic-web runtime from <code>/runtime/index.js</code>, runs the
        <code> patient_navigator</code> network with the browser mock router, asks for consent before
        contacting the trial node, then fetches the node&apos;s <code>criteria/index.json</code>.
      </p>
      <SpikeRunner />
    </main>
  );
}
