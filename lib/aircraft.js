'use strict';
// Citation XLS+ (Model 560XL) planning profile. Figures are representative published values for
// advisory screening only; the AFM and your company's OpSpecs/SOPs always govern. All are overridable from the UI.
module.exports = {
  CE56X: {
    name: 'Cessna Citation XLS+ (560XL)',
    maxAltitudeFt: 45000,
    cruiseKtas: 430, // typical high-speed cruise ~430-441 KTAS
    climbDescentAvgKt: 300,
    stillAirRangeNm: 1850, // NBAA IFR reserves, ~4 pax
    maxDemoCrosswindKt: 25,
    maxTailwindKt: 10,
    minRunwayFt: 5000, // screening value: ~3,560 ft TO / ~3,180 ft landing (SL, ISA, MTOW/MLW) plus Part 135 60% factoring
    absoluteMinRunwayFt: 4000,
    fiki: true, // approved for flight in known (not severe) icing
    reserveMin: 45,
    serviceCeilingNote: 'Certified ceiling FL450. Convective tops at or above FL430 effectively cannot be overflown with required clearance.',
  },
};
