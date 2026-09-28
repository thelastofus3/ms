import React from "react";
import { createRoot } from "react-dom/client";
import { GaussianStudio } from "./gaussian/Studio";
import "./style.css";
createRoot(document.getElementById("root")!).render(<GaussianStudio />);
