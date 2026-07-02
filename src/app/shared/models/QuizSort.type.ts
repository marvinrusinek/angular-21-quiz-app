// Two independent sort dimensions for the QuizSelection list.
//  - DifficultyDirection: primary grouping (↑ arrows)
//      'asc'  = beginner → advanced
//      'desc' = advanced → beginner
//  - AlphaDirection: alphabetical order applied WITHIN each difficulty group
//      'az' = A → Z
//      'za' = Z → A
export type DifficultyDirection = 'asc' | 'desc';
export type AlphaDirection = 'az' | 'za';
