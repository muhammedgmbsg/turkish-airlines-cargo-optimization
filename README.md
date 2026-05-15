# Process Optimization and Operational Efficiency in Air Cargo Transportation: A Case Study at Turkish Airlines

This repository contains the operational efficiency framework, Value Stream Mapping (VSM) analysis, and mathematical optimization models developed to streamline international air cargo processes at Turkish Airlines (THY).

The project focuses on identifying non-value-added activities, reducing bottlenecks, and minimizing cargo processing times from acceptance to flight departure.

## Overview

Air cargo logistics demand high speed and precision. Inefficient processes during cargo acceptance, security screening, build-up (palletization), and documentation directly increase lead times. This study addresses these inefficiencies through a hybrid approach combining lean management tools and mathematical modeling.

* **Value Stream Mapping (VSM):** Used to map the current state of cargo operations, highlighting wait times and non-value-added steps. A future-state map is designed to drastically shorten total lead time.
* **Mathematical Modeling:** An optimization model is structured to minimize total processing time and optimize resource allocation at the terminal.
* **Operational Impact:** The methodology targets critical nodes such as the X-ray security bottlenecks and documentation delays to ensure smoother transit lines.

## Methodology

The optimization framework is divided into four primary stages:
1. **Process Mapping:** Detailing the chronological steps an international cargo shipment undergoes at the THY terminal.
2. **Current State Analysis:** Calculating the Takt Time, Cycle Time (C/T), and Changeover Time for each station to detect where cargo stacks up.
3. **Waste Identification:** Isolating transportation, motion, waiting, and over-processing wastes within the warehouse floor.
4. **Mathematical Formulation:** Defining objective functions and constraints based on worker capacity, machine availability (X-ray), and flight schedule deadliness to minimize overall terminal duration.

## Key Focus Areas

* **Cargo Acceptance:** Accelerating initial physical and document checks.
* **Security & Screening:** Optimizing X-ray queuing and throughput speeds.
* **Storage & Staging:** Efficient temporary allocation of Unit Load Devices (ULDs) based on flight priority.
* **Build-Up (Palletization):** Minimizing the time required to group and secure cargo according to aircraft weight and balance configurations.

## Repository Structure

* `vsm_analysis/`: Value stream maps (Current and Future States) and process data spreadsheets.
* `optimization_models/`: Mathematical formulas, constraint definitions, and Python/LP solver scripts.
* `data/`: Sample process parameters, cycle times, and structural constraints used for model validation.

## Requirements

* Python 3.x
* PuLP / Gurobi / SciPy (for solving mathematical models)
* Pandas / NumPy (for data analysis)
* Lucidchart or similar vector tools (for viewing VSM source files)

## Future Scope

* Integrating real-time IoT tracking data to dynamically update the mathematical optimization model.
* Applying machine learning algorithms to predict cargo arrival spikes and pre-allocate terminal staff.
* Simulating the optimized future-state workflow using discrete-event simulation software to validate real-world performance under varying flight schedules.

## Citation

If you reference this optimization framework in your academic or professional work, please cite the original study:

Turkish Airlines Cargo Optimization Project. Operational Efficiency and Process Optimization in Air Cargo Transportation using Value Stream Mapping and Mathematical Modeling.
