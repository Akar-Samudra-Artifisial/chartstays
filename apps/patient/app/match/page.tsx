import MatchView from "./match-view";

export const metadata = {
  title: "Find trials · ChartStays",
  description: "Match your record against public trial criteria in your browser; the Trust panel counts any values from your record in requests to trial sites.",
};

export default function MatchPage() {
  return (
    <main id="content" tabIndex={-1}>
      <p className="back-link">
        <a href="/#get-started">
          <span aria-hidden="true">←</span> Your record
        </a>
      </p>
      <h1 className="page-title">Find clinical trials</h1>
      <p className="lead">
        Trial sites send their public criteria to this page and matching runs here, on your device. The Trust panel below counts anything from your
        record found in what is sent to them.
      </p>
      <MatchView />
    </main>
  );
}
